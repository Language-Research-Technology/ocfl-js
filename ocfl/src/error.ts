class NotImplementedError extends Error {
  constructor(methodName?: string) {
    const msg = methodName ? `Method ${methodName} has not been implemented` : '';
    super(msg);
    this.name = 'NotImplementedError';
  }
}

class ObjectNotLoadedError extends Error {
  constructor(label: string) {
    super(`OCFL Object "${label}" is not loaded; call load() first`);
    this.name = 'ObjectNotLoadedError';
  }
}

class ObjectNotFoundError extends Error {
  constructor(label: string) {
    super(`OCFL Object "${label}" does not exist`);
    this.name = 'ObjectNotFoundError';
  }
}

export { NotImplementedError, ObjectNotFoundError, ObjectNotLoadedError };
