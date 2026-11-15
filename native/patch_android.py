# Adapte le projet Android généré par Capacitor : permissions, widget, code natif, icônes.
import pathlib, shutil, sys
root = pathlib.Path('android/app/src/main')
m = root / 'AndroidManifest.xml'
x = m.read_text()
perms = ''.join(f'\n    <uses-permission android:name="android.permission.{p}" />' for p in ['CAMERA', 'VIBRATE', 'REQUEST_INSTALL_PACKAGES'])
x = x.replace('<uses-permission android:name="android.permission.INTERNET" />', '<uses-permission android:name="android.permission.INTERNET" />' + perms)
x = x.replace('</application>', '''    <receiver android:name=".PokeWidget" android:exported="false" android:label="PokeScan">
            <intent-filter><action android:name="android.appwidget.action.APPWIDGET_UPDATE" /></intent-filter>
            <meta-data android:name="android.appwidget.provider" android:resource="@xml/poke_widget_info" />
        </receiver>
    </application>''')
# raccourcis (appui long sur l'icône) et tuile des réglages rapides
x = x.replace('</activity>', '    <meta-data android:name="android.app.shortcuts" android:resource="@xml/shortcuts" />\n        </activity>', 1)
x = x.replace('</application>', '''    <service android:name=".ScanTile" android:exported="true" android:label="Scanner une carte" android:icon="@drawable/sc_tile"
            android:permission="android.permission.BIND_QUICK_SETTINGS_TILE">
            <intent-filter><action android:name="android.service.quicksettings.action.QS_TILE" /></intent-filter>
        </service>
    </application>''')
m.write_text(x)
assert x.count('android.permission.') == 5 and 'PokeWidget' in x and 'shortcuts' in x, 'manifeste non modifié'
src = pathlib.Path('native')
for j in src.glob('*.java'): shutil.copy(j, root / 'java/fr/pierrick/pokescan' / j.name)
shutil.copytree(src / 'res', root / 'res', dirs_exist_ok=True)
# splash par défaut Capacitor remplacé partout par le nôtre
for p in (root / 'res').glob('drawable*/splash.png'): shutil.copy(src / 'res/drawable/splash.png', p)
# numéro de version = numéro du build (les mises à jour montent toujours)
import os, re
n = os.environ.get('GITHUB_RUN_NUMBER')
if n:
    g = pathlib.Path('android/app/build.gradle'); t = g.read_text()
    t = re.sub(r'versionCode \d+', f'versionCode {n}', t); t = re.sub(r'versionName "[^"]*"', f'versionName "{n}"', t)
    g.write_text(t); assert f'versionCode {n}' in t
# moteur de scan natif : caméra CameraX, lecture de texte ML Kit (embarquée, hors ligne), TensorFlow Lite (LiteRT)
g = pathlib.Path('android/app/build.gradle'); t = g.read_text()
deps = """
    implementation "androidx.camera:camera-core:1.4.2"
    implementation "androidx.camera:camera-camera2:1.4.2"
    implementation "androidx.camera:camera-lifecycle:1.4.2"
    implementation "androidx.camera:camera-view:1.4.2"
    implementation "com.google.mlkit:text-recognition:16.0.1"
    implementation "com.google.ai.edge.litert:litert:1.4.2"
"""
t = t.replace('\ndependencies {', '\ndependencies {' + deps, 1)
# bibliothèques natives des téléphones seulement (pas les émulateurs x86) : APK bien plus légère
t = t.replace('defaultConfig {', "defaultConfig {\n        ndk { abiFilters 'arm64-v8a', 'armeabi-v7a' }", 1)
g.write_text(t); assert 'mlkit:text-recognition' in t and 'abiFilters' in t, 'dépendances non ajoutées'
print('android patché')
