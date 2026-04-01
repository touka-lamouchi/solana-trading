// Stub — will be replaced with Prometheus metrics later
export const metrics = {
  tradeExecuted: () => {},
  tradeSkipped: () => {},
  tradeFailed: () => {},
  opportunityDetected: (type: string) => {},
  latency: (label: string, ms: number) => {},
};