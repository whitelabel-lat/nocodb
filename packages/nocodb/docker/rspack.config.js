// Bundle for the Docker image. Entry serves the static GUI from ./nc-gui.
const path = require('path');
const { rspack } = require('@rspack/core');
const nodeExternals = require('webpack-node-externals');

module.exports = {
  entry: './src/run/local.ts',
  mode: 'production',
  target: 'node',
  module: {
    rules: [
      {
        test: /\.node$/,
        loader: 'node-loader',
        options: { name: '[path][name].[ext]' },
      },
      {
        test: /\.tsx?$/,
        exclude: /node_modules/,
        loader: 'builtin:swc-loader',
        options: {
          sourceMaps: false,
          jsc: {
            parser: {
              syntax: 'typescript',
              tsx: true,
              decorators: true,
              dynamicImport: true,
            },
            transform: { legacyDecorator: true, decoratorMetadata: true },
            target: 'es2017',
            loose: true,
            externalHelpers: false,
            keepClassNames: true,
          },
          module: {
            type: 'commonjs',
            strict: false,
            strictMode: true,
            lazy: false,
            noInterop: false,
          },
        },
      },
    ],
  },
  resolve: {
    extensions: ['.tsx', '.ts', '.js', '.json', '.node'],
    tsConfig: { configFile: path.resolve('tsconfig.json') },
    alias: {
      // The core package is not under packages/ (see tsconfig paths).
      '@noco-local-integrations/core$': path.resolve(
        __dirname,
        '../../noco-integrations/core',
      ),
      '@noco-local-integrations': path.resolve(
        __dirname,
        '../../noco-integrations/packages',
      ),
    },
  },
  output: {
    path: path.resolve(__dirname),
    filename: 'index.js',
    library: 'libs',
    libraryTarget: 'umd',
    globalObject: "typeof self !== 'undefined' ? self : this",
  },
  // Do not minify: keeps class names and saves build memory.
  optimization: { minimize: false, nodeEnv: false },
  externals: [nodeExternals({ allowlist: ['nocodb-sdk'] })],
  plugins: [new rspack.EnvironmentPlugin({ EE: true })],
  node: { __dirname: false },
};
