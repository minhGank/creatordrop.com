export const createSyntheticEnvironment = (
  overrides: Readonly<NodeJS.ProcessEnv> = {},
): NodeJS.ProcessEnv => ({
  NODE_ENV: 'test',
  ...overrides,
});
