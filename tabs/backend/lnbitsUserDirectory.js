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

// Every LNbits user linked to an Entra object id. Provisioning needs the whole
// list — a duplicate is exactly the case it has to detect and repair — while
// reads want the stricter unique lookup below.
const findUsersByAadObjectId = (users, aadObjectId) => {
  if (!Array.isArray(users)) {
    throw new Error('LNbits users response is not an array');
  }
  return users.filter((user) => {
    const extra = parseExtra(user);
    return (
      user?.external_id === aadObjectId ||
      user?.aadObjectId === aadObjectId ||
      extra.aadObjectId === aadObjectId
    );
  });
};

const findUniqueUserByAadObjectId = (users, aadObjectId) => {
  const matches = findUsersByAadObjectId(users, aadObjectId);
  if (matches.length > 1) {
    throw new Error(`More than one LNbits user is linked to Entra id ${aadObjectId}`);
  }
  return matches[0] || null;
};

module.exports = {
  findUniqueUserByAadObjectId,
  findUsersByAadObjectId,
  parseExtra,
};
