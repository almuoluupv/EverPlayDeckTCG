export function createMemoryDirectoryDeps() {
  const userRows = [];
  const albumRows = new Map();
  let planRows = null;
  const logRows = [];
  const codeRows = [];

  return {
    users: {
      async findOne(filter) {
        return userRows.find((row) => Object.entries(filter).every(([key, value]) => row[key] === value)) || null;
      },
      async insertOne(doc) {
        if (userRows.some((row) => row.userId === doc.userId)) {
          const err = new Error('duplicado');
          err.code = 11000;
          throw err;
        }
        userRows.push({ ...doc });
      },
      async updateOne(filter, update) {
        const row = userRows.find((item) => item.userId === filter.userId);
        if (row && update.$set) Object.assign(row, update.$set);
      },
      async countDocuments(filter) {
        return userRows.filter((row) => Object.entries(filter).every(([key, value]) => row[key] === value)).length;
      },
      async list() {
        return userRows.map((row) => ({ ...row }));
      },
    },
    albums: {
      async get(userId) {
        return albumRows.get(userId) || [];
      },
      async put(userId, cards) {
        albumRows.set(userId, cards);
      },
    },
    plans: {
      async load() {
        return planRows;
      },
      async save(next) {
        planRows = next.map((plan) => ({ ...plan }));
      },
    },
    codes: {
      async insertOne(doc) {
        if (codeRows.some((row) => row.code === doc.code)) {
          const err = new Error('duplicado');
          err.code = 11000;
          throw err;
        }
        codeRows.push({ ...doc });
      },
      async claim(code, userId, at) {
        const row = codeRows.find((item) => item.code === code && item.redeemedAt == null);
        if (!row) return null;
        const before = { ...row };
        row.redeemedAt = at;
        row.redeemedBy = userId;
        return before;
      },
      async release(code) {
        const row = codeRows.find((item) => item.code === code);
        if (!row) return;
        row.redeemedAt = null;
        row.redeemedBy = '';
      },
      async list(limit) {
        return codeRows
          .slice()
          .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
          .slice(0, limit)
          .map((row) => ({ ...row }));
      },
    },
    logs: {
      async insert(entry) {
        logRows.push({ ...entry });
      },
      async latest(limit) {
        return logRows.slice(-limit).reverse().map((row) => ({ ...row }));
      },
      async trim(keep) {
        if (logRows.length > keep) logRows.splice(0, logRows.length - keep);
      },
    },
  };
}
