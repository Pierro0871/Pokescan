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
m.write_text(x)
assert x.count('android.permission.') == 4 and 'PokeWidget' in x, 'manifeste non modifié'
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
print('android patché')
