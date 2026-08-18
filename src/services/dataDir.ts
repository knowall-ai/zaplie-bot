// Single resolution rule for ZAPLIE_DATA_DIR, the directory holding the bot's
// mutable on-disk state.
//
// Every deployed runtime must point it at an absolute, persistent path outside
// the deployment artifact: state written into `wwwroot` is destroyed by the
// next clean deploy. Only an explicit `NODE_ENV=development` run that is not on
// Azure may fall back to the git-ignored `.zaplie-data` directory, so a
// forgotten setting fails at startup instead of silently losing money records.

import * as path from 'path';

export class DataDirError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'DataDirError';
  }
}

export const DEVELOPMENT_DATA_DIR = '.zaplie-data';

const isAzureRuntime = (environment: NodeJS.ProcessEnv): boolean =>
  Boolean(
    environment.RUNNING_ON_AZURE ||
    environment.WEBSITE_INSTANCE_ID ||
    environment.WEBSITE_SITE_NAME,
  );

export const resolveDataDir = (
  environment: NodeJS.ProcessEnv = process.env,
  workingDirectory = process.cwd(),
): string => {
  const configured = environment.ZAPLIE_DATA_DIR?.trim();
  const durableRuntime =
    environment.NODE_ENV !== 'development' || isAzureRuntime(environment);

  if (configured) {
    if (durableRuntime && !path.isAbsolute(configured)) {
      throw new DataDirError(
        'ZAPLIE_DATA_DIR must be an absolute durable path in production',
      );
    }
    return path.resolve(workingDirectory, configured);
  }

  if (durableRuntime) {
    throw new DataDirError(
      'ZAPLIE_DATA_DIR is required outside explicit development mode',
    );
  }

  return path.resolve(workingDirectory, DEVELOPMENT_DATA_DIR);
};
