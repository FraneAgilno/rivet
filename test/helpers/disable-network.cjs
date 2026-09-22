globalThis.fetch = async function disabledNetworkRequest() {
  throw new Error('Network access is disabled in CLI characterization tests.');
};
