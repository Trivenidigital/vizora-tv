import { registerPlugin } from '@capacitor/core';

interface SecureStoragePlugin {
  set(options: { key: string; value: string }): Promise<void>;
  get(options: { key: string }): Promise<{ value: string | null }>;
  remove(options: { key: string }): Promise<void>;
  has(options: { key: string }): Promise<{ value: boolean }>;
}

const SecureStorage = registerPlugin<SecureStoragePlugin>('SecureStorage');

export { SecureStorage };
