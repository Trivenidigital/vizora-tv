import { registerPlugin, WebPlugin } from '@capacitor/core';

interface SecureStoragePlugin {
  set(options: { key: string; value: string }): Promise<void>;
  get(options: { key: string }): Promise<{ value: string | null }>;
  remove(options: { key: string }): Promise<void>;
  has(options: { key: string }): Promise<{ value: boolean }>;
}

/**
 * Web/TV fallback for the native SecureStorage plugin.
 *
 * On Android the native plugin backs this with Keystore-encrypted
 * EncryptedSharedPreferences. The Samsung Tizen and LG webOS web runtimes
 * expose no hardware keystore to web apps, so this fallback persists to
 * localStorage under a dedicated prefix.
 *
 * ACCEPTED LIMITATION (documented in docs/SAMSUNG_LG_TV.md): on TV platforms
 * the device JWT is stored unencrypted inside the app's sandboxed local
 * storage. The OS app sandbox is the protection boundary there — the same
 * boundary every Tizen/webOS signage app operates under. Do NOT add fake
 * crypto here (a bundled key is obfuscation, not encryption).
 */
class SecureStorageWeb extends WebPlugin implements SecureStoragePlugin {
  private static readonly PREFIX = 'vizora_secure_';

  async set(options: { key: string; value: string }): Promise<void> {
    localStorage.setItem(SecureStorageWeb.PREFIX + options.key, options.value);
  }

  async get(options: { key: string }): Promise<{ value: string | null }> {
    return { value: localStorage.getItem(SecureStorageWeb.PREFIX + options.key) };
  }

  async remove(options: { key: string }): Promise<void> {
    localStorage.removeItem(SecureStorageWeb.PREFIX + options.key);
  }

  async has(options: { key: string }): Promise<{ value: boolean }> {
    return { value: localStorage.getItem(SecureStorageWeb.PREFIX + options.key) !== null };
  }
}

const SecureStorage = registerPlugin<SecureStoragePlugin>('SecureStorage', {
  web: () => new SecureStorageWeb(),
});

export { SecureStorage };
