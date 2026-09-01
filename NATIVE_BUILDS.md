# Instaladores nativos de SmartMarket

El workflow `Instaladores nativos` genera desde GitHub Actions:

- un APK Android instalable;
- un DMG para macOS;
- un instalador EXE para Windows.

Se puede ejecutar manualmente en **GitHub → Actions → Instaladores nativos → Run workflow**.
Los resultados aparecen en la sección **Artifacts** de la ejecución.

## Firmas necesarias para publicar actualizaciones

### Android

Antes de publicar en Google Play hay que crear y conservar una clave de subida. La misma clave,
identificador `com.smartmarket.comparador` y un `versionCode` creciente permiten actualizar la app
sin borrar los datos del usuario.

Configura estos secretos del repositorio:

- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

Sin esos secretos GitHub genera un APK de prueba. No debe publicarse porque cada entorno puede
firmarlo con una clave distinta y no garantiza futuras actualizaciones.

### macOS y Windows

La clave privada del actualizador se creó localmente en
`src-tauri/smartmarket-updater.key` y está excluida de Git. Debe conservarse fuera del repositorio y
copiarse al secreto `TAURI_SIGNING_PRIVATE_KEY`. La clave pública sí forma parte de la configuración.

Para evitar avisos de seguridad también serán necesarios un certificado Apple Developer ID y un
certificado de firma de código para Windows. Estos certificados son distintos de la firma interna
del actualizador de Tauri.

## Publicación

Al crear una etiqueta como `v1.1.0`, el workflow vuelve a compilar todos los instaladores. Para que
las aplicaciones de escritorio se actualicen automáticamente, la publicación de GitHub debe incluir
los paquetes firmados y el archivo `latest.json` generado para Tauri.
