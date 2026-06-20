export function createMessageRouter(commands) {
  const commandMap = { ...commands };

  return function routeMessage(message, sendResponse) {
    const action = message?.action;
    if (!action || !Object.hasOwn(commandMap, action)) return false;

    Promise.resolve()
      .then(() => commandMap[action](message))
      .then(result => sendResponse(result))
      .catch(error => sendResponse({
        ok: false,
        error: String(error?.message || error),
      }));
    return true;
  };
}

