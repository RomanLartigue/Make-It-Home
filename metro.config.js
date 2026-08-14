// Metro config.
//
// Release builds crashed at launch while dev builds worked — the difference is
// that release bundles are minified. Minification (name-mangling / compression)
// can break libraries that rely on function or class names at runtime, causing a
// release-only crash. Disabling those transforms keeps the release bundle behaving
// like the (working) dev bundle. It's slightly larger but correct.
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

config.transformer.minifierConfig = {
  compress: false,
  mangle: false,
};

module.exports = config;
