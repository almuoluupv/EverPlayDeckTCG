export function createMemoryDirectoryDeps() {
  const userRows = [];
  const albumRows = new Map();
  let planRows = null;
  const logRows = [];

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
