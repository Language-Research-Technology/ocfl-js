class NotImplementedError extends Error {
  constructor(methodName?: string) {
    const msg = methodName ? `Method ${methodName} has not been implemented` : '';
    super(msg);
    this.name = 'NotImplementedError';
  }
}

export { NotImplementedError };
