// A stable pre-push seed, an explicit CI budget, and the path printed on failure make races replayable.
export const fastCheckOptions = {
  numRuns: Number(process.env.FC_NUM_RUNS ?? 50),
  seed: Number(process.env.FC_SEED ?? 730100),
  ...(process.env.FC_PATH ? { path: process.env.FC_PATH } : {}),
};
