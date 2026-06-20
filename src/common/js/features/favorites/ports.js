function createSafePostMessage(port, onError) {
  return message => {
    try {
      if (port?.name === undefined) return false;
      port.postMessage(message);
      return true;
    } catch (error) {
      onError?.(error);
      return false;
    }
  };
}

async function openThemes(themes, limit, getCount, postMessage, onError) {
  let count = 0;
  for (const theme of themes) {
    Promise.resolve(theme.open(false, false))
      .then(result => {
        const openedTheme = Array.isArray(result) ? result[1] : null;
        if (openedTheme?.viewed) {
          postMessage({ id: openedTheme.id, count: getCount() });
        }
      })
      .catch(onError);
    if (++count >= limit) break;
  }
}

export function createFavoritesPortHandler({
  getFavorites,
  getPinnedFavorites,
  getCount,
  getOpenLimit,
  onError,
}) {
  return async function handleFavoritesPort(port) {
    const postMessage = createSafePostMessage(port, onError);

    if (port.name === 'themes-read-all') {
      for (const theme of getFavorites()) {
        if (await theme.read()) postMessage({ id: theme.id, count: getCount() });
      }
      return true;
    }
    if (port.name === 'themes-open-all') {
      await openThemes(getFavorites(), getOpenLimit(), getCount, postMessage, onError);
      return true;
    }
    if (port.name === 'themes-open-all-pin') {
      await openThemes(getPinnedFavorites(), getOpenLimit(), getCount, postMessage, onError);
      return true;
    }
    return false;
  };
}
