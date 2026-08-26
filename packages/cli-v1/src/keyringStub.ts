export class Entry {
  getPassword(): never {
    throw new Error("Native Realmroot login is unavailable in the Agent Runtime standalone CLI");
  }

  setPassword(_password: string): never {
    throw new Error("Native Realmroot login is unavailable in the Agent Runtime standalone CLI");
  }

  deletePassword(): never {
    throw new Error("Native Realmroot login is unavailable in the Agent Runtime standalone CLI");
  }
}
