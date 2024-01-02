import fs from "fs";
import fetch from "node-fetch";
import path from "path";

import { waitFor } from "coral-common/common/lib/helpers";
import { Config } from "coral-server/config";
import logger from "coral-server/logger";

import Entrypoints, { Entrypoint, RawEntrypoint } from "./entrypoints";

/**
 * Sometimes webpack-assets-manifest creates an invalid manifest, probably
 * due to hot module replacement issues, which is fixed in newer 5.x versions.
 * However we can't upgrade yet as the 5.x versions require webpack 5.
 *
 * TODO: (cvle) Unsure if we need this. Does `webpack-assets-manifest` always
 * eventually create a valid manifest? Needs more investigation. Setting it to
 * a high number for now.
 **/
const INVALID_MANIFEST_MAX_RETRIES = 9999;

export interface Asset {
  src: string;
  integrity: string;
}

/**
 * Manifest is the full raw manifest that is generated by the webpack plugin.
 */
export type Manifest = {
  /**
   * entrypoints are generated by the webpack plugin for each of the entrypoints
   * with their required chunks.
   */
  entrypoints: Record<string, RawEntrypoint>;
} & Record<string, Asset>;

interface ManifestLoaderOptions {
  /** If set, load manifest from webpack dev server instead */
  fromWebpackDevServerURL?: string | null;

  /** If set, inject the dev server bundle into entrypoint */
  injectWebpackDevServerBundle?: boolean;
}

export type EntrypointLoader = () => Promise<Readonly<Entrypoint> | null>;

function loadManifestFromFile(manifestFilename: string): Manifest | null {
  // TODO: (wyattjoh) figure out a better way of referencing paths.
  // Load the entrypoint manifest.
  const manifestFilepath = path.join(
    __dirname,
    "..",
    "..",
    "..",
    "..",
    "..",
    "..",
    "client",
    "dist",
    "static",
    manifestFilename
  );

  logger.info({ path: manifestFilepath }, "attempting to load manifest");

  try {
    // Load the manifest.
    const manifest = JSON.parse(
      fs.readFileSync(manifestFilepath, { encoding: "utf8" })
    );
    return manifest;
  } catch (err) {
    logger.error(
      { err },
      "could not load the manifest, maybe you need to run `npm run build` on the client?"
    );
  }
  return null;
}
export default class ManifestLoader {
  private manifestFilename: string;
  private manifest: Manifest | null = null;
  private entrypoints: Entrypoints | null = null;
  private options: ManifestLoaderOptions;
  private invalidManifestCounter = 0;

  constructor(manifestFilename: string, options: ManifestLoaderOptions = {}) {
    this.manifestFilename = manifestFilename;
    this.options = options;

    if (!options.fromWebpackDevServerURL) {
      this.manifest = loadManifestFromFile(this.manifestFilename);
      if (!this.manifest) {
        throw new Error(
          `Failed to load manifest file ${this.manifestFilename}`
        );
      }
      // Load directly from file and cache it.
      this.entrypoints = new Entrypoints(this.manifest);
      if (!this.entrypoints) {
        throw new Error(
          `Failed to parse manifest file ${this.manifestFilename}`
        );
      }
    }
  }

  public async load(): Promise<Manifest> {
    if (this.options.fromWebpackDevServerURL) {
      const url = `${this.options.fromWebpackDevServerURL}/${this.manifestFilename}`;
      const fetchManifest = async () => {
        // Loading manifests from Webpack Dev Server each time this is called.
        logger.info(`Loading manifests from Webpack Dev Server '${url}'`);
        const res = await fetch(url);
        if (!res.ok) {
          logger.error(
            { manifest: url },
            "could not load the generated manifest"
          );
          return null;
        }
        const manifest: Manifest = await res.json();
        if (
          !manifest.entrypoints ||
          !manifest.entrypoints[Object.keys(manifest.entrypoints)[0]].assets.js
        ) {
          this.invalidManifestCounter++;
          if (this.invalidManifestCounter > INVALID_MANIFEST_MAX_RETRIES) {
            throw new Error(`Invalid manifest while loading '${url}'`);
          }
          return null;
        }
        // We got a valid manifest, reset counter.
        this.invalidManifestCounter = 0;
        const firstEntrypoint = Object.keys(manifest.entrypoints)[0];
        if (
          !firstEntrypoint ||
          !manifest.entrypoints[firstEntrypoint].assets.js
        ) {
          // No entrypoint found or no js entry for first entrypoint, probably not ready -> retry!
          return null;
        }
        return manifest;
      };

      // During development we continously try to fetch the manifest from webpack dev server.
      const fetchManifestAndRetry = async (
        waitForMS = 1000
      ): Promise<Manifest> => {
        const manifest = await fetchManifest();
        if (manifest) {
          return manifest;
        }
        logger.warn(`Failed to load entrypoint, retrying in ${waitForMS}ms`);
        await waitFor(waitForMS);
        return await fetchManifestAndRetry(waitForMS * 1.5);
      };
      return await fetchManifestAndRetry();
    }
    // Used cached manifest loaded from file during production instead.
    if (this.manifest) {
      return this.manifest;
    }
    throw new Error(`Failed to load entrypoint ${name}`);
  }

  public createEntrypointLoader(name: string): EntrypointLoader {
    if (this.options.fromWebpackDevServerURL) {
      return async () => {
        let entrypoint = new Entrypoints(await this.load()).get(name);
        // Inject webpack dev server script.
        if (entrypoint && this.options.injectWebpackDevServerBundle) {
          entrypoint = {
            ...entrypoint,
            js: [
              ...entrypoint.js,
              { src: `webpack-dev-server.js`, integrity: "" },
            ],
          };
        }
        return entrypoint;
      };
    }
    // Used cached manifest loaded from file instead.
    if (this.entrypoints) {
      const entrypoint = this.entrypoints.get(name);
      return () => Promise.resolve(entrypoint);
    }
    throw new Error(`Failed to load entrypoint ${name}`);
  }
}

export function createManifestLoader(config: Config, manifestFilename: string) {
  const fromWebpackDevServerURL =
    process.env.WEBPACK_DEV_SERVER === "true"
      ? // Loading manifests from Webpack Dev Server
        `http://127.0.0.1:${config.get("dev_port")}`
      : null;
  return new ManifestLoader(manifestFilename, {
    fromWebpackDevServerURL,
    injectWebpackDevServerBundle: process.env.WEBPACK_DEV_SERVER === "true",
  });
}
