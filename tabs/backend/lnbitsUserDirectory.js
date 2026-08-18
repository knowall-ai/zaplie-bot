const parseExtra = (user) => {
  if (!user || user.extra === null || user.extra === undefined) {
    return {};
  }
  if (typeof user.extra === 'object' && !Array.isArray(user.extra)) {
    return user.extra;
  }
  if (typeof user.extra === 'string') {
    try {
      const parsed = JSON.parse(user.extra);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed
        : {};
    } catch (_error) {
      return {};
    }
  }
  return {};
};

const findUniqueUserByAadObjectId = (users, aadObjectId) => {
  if (!Array.isArray(users)) {
    throw new Error('LNbits users response is not an array');
  }
  const matches = users.filter((user) => {
    const extra = parseExtra(user);
    return (
      user?.external_id === aadObjectId ||
      user?.aadObjectId === aadObjectId ||
      extra.aadObjectId === aadObjectId
    );
  });
  if (matches.length > 1) {
    throw new Error(`More than one LNbits user is linked to Entra id ${aadObjectId}`);
  }
  return matches[0] || null;
};

module.exports = { findUniqueUserByAadObjectId, parseExtra };
