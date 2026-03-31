/**
 * Vizora Android TV Display Client
 *
 * Built with Capacitor for native Android TV support.
 * Features:
 * - Native Android performance
 * - D-pad navigation support
 * - Hardware acceleration for video
 * - Background service capability
 * - Auto-start on boot
 * - Persistent storage via Capacitor Preferences
 */

import { App } from '@capacitor/app';
import { Network } from '@capacitor/network';
import { Preferences } from '@capacitor/preferences';
import { SplashScreen } from '@capacitor/splash-screen';
import { CapacitorHttp, HttpResponse } from '@capacitor/core';
import { io, Socket } from 'socket.io-client';
import { AndroidCacheManager } from './cache-manager';
import { SecureStorage } from './secure-storage';
import { transformContentUrl, injectContentSecurityPolicy } from './utils';

declare const __APP_VERSION__: string;

// Configuration - can be overridden via URL params or stored preferences
const DEFAULT_CONFIG = {
  apiUrl: import.meta.env.VITE_API_URL || 'http://localhost:3000',
  realtimeUrl: import.meta.env.VITE_REALTIME_URL || 'http://localhost:3002',
  dashboardUrl: import.meta.env.VITE_DASHBOARD_URL || 'http://localhost:3001',
};

interface Config {
  apiUrl: string;
  realtimeUrl: string;
  dashboardUrl: string;
}

interface Playlist {
  id: string;
  name: string;
  items: PlaylistItem[];
  loopPlaylist?: boolean;
}

interface PlaylistItem {
  id: string;
  contentId: string;
  duration: number;
  order: number;
  content: {
    id: string;
    name: string;
    type: string;
    url: string;
    thumbnail?: string;
    mimeType?: string;
    duration?: number;
  } | null;
}

interface PushContent {
  id: string;
  name: string;
  type: string;
  url: string;
  thumbnailUrl?: string;
  mimeType?: string;
  duration?: number;
}

interface QrOverlayConfig {
  enabled: boolean;
  url: string;
  position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  size?: number;
  margin?: number;
  backgroundColor?: string;
  opacity?: number;
  label?: string;
}

interface LayoutMetadata {
  gridTemplate?: { columns?: string; rows?: string };
  gap?: number;
  backgroundColor?: string;
  zones: LayoutZone[];
}

interface LayoutZone {
  id: string;
  gridArea: string;
  resolvedPlaylist?: Playlist;
  resolvedContent?: PlaylistItem['content'];
}

interface HeartbeatResponse {
  commands?: Array<{ type: string; payload?: Record<string, unknown>; [key: string]: unknown }>;
}

interface PerformanceMemory {
  usedJSHeapSize: number;
  jsHeapSizeLimit: number;
}

class VizoraAndroidTV {
  private socket: Socket | null = null;
  private deviceId: string | null = null;
  private deviceToken: string | null = null;
  private pairingCode: string | null = null;
  private pairingCountdownInterval: ReturnType<typeof setInterval> | null = null;
  private pairingExpiresAt: number = 0;
  private pairingCheckInterval: ReturnType<typeof setInterval> | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private offlineTimeout: ReturnType<typeof setTimeout> | null = null;
  private config: Config = DEFAULT_CONFIG;
  private startTime: number = Date.now();
  private currentContentId: string | null = null;
  private contentStartTime: number = 0;

  private currentPlaylist: Playlist | null = null;
  private currentIndex = 0;
  private playbackTimer: ReturnType<typeof setTimeout> | null = null;
  private isOnline = true;
  private cacheManager = new AndroidCacheManager();

  // Temporary content push state
  private temporaryContent: PushContent | null = null;
  private temporaryContentTimer: ReturnType<typeof setTimeout> | null = null;
  private savedPlaylistState: { playlist: Playlist; index: number } | null = null;

  // Pairing retry state
  private pairingRetryCount = 0;

  private zoneTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private zoneIndices: Map<string, number> = new Map();
  private dpadHandler: ((event: KeyboardEvent) => void) | null = null;

  constructor() {
    this.init().catch(err => {
      console.error('[Vizora] Fatal initialization error:', err);
      this.showError('Failed to initialize. Please restart the app.');
    });
  }

  private async init() {
    console.log('[Vizora] Initializing Android TV display client...');

    // Load configuration
    await this.loadConfig();

    // Setup Capacitor plugins
    await this.setupCapacitor();

    // Check for existing device token (from encrypted storage)
    await this.migrateCredentialsToSecureStorage();
    const storedToken = await SecureStorage.get({ key: 'device_token' });
    const storedDeviceId = await SecureStorage.get({ key: 'device_id' });

    this.deviceToken = storedToken.value;
    this.deviceId = storedDeviceId.value;

    if (this.deviceToken && this.deviceId) {
      console.log('[Vizora] Found existing device credentials, connecting...');

      // Restore last playlist for offline resilience
      try {
        const lastPlaylist = await Preferences.get({ key: 'last_playlist' });
        if (lastPlaylist.value) {
          this.currentPlaylist = JSON.parse(lastPlaylist.value);
          console.log('[Vizora] Restored last playlist from storage');
        }
      } catch (err) {
        console.warn('[Vizora] Failed to restore last playlist:', err);
      }

      // Show content screen after playlist restore to avoid blank flash
      // (also prevents showing pairing screen on restart — BUG #7)
      this.showScreen('content');

      // Start playback immediately from restored playlist (don't wait for WebSocket).
      // The connect handler also calls playContent() as a fallback, but starting here
      // ensures content is visible even if the WebSocket connection is slow or offline.
      if (this.currentPlaylist && this.currentPlaylist.items?.length > 0) {
        this.playContent();
      }

      this.connectToRealtime();
    } else {
      console.log('[Vizora] No credentials found, starting pairing flow...');
      this.startPairing();
    }

    // Hide splash screen
    await SplashScreen.hide();
  }

  private async loadConfig() {
    // Try to load config from URL params first
    const urlParams = new URLSearchParams(window.location.search);

    const apiUrl = urlParams.get('api_url');
    const realtimeUrl = urlParams.get('realtime_url');
    const dashboardUrl = urlParams.get('dashboard_url');

    if (apiUrl) this.config.apiUrl = apiUrl;
    if (realtimeUrl) this.config.realtimeUrl = realtimeUrl;
    if (dashboardUrl) this.config.dashboardUrl = dashboardUrl;

    // Try to load from stored preferences
    const storedApiUrl = await Preferences.get({ key: 'config_api_url' });
    const storedRealtimeUrl = await Preferences.get({ key: 'config_realtime_url' });
    const storedDashboardUrl = await Preferences.get({ key: 'config_dashboard_url' });

    if (storedApiUrl.value && !apiUrl) this.config.apiUrl = storedApiUrl.value;
    if (storedRealtimeUrl.value && !realtimeUrl) this.config.realtimeUrl = storedRealtimeUrl.value;
    if (storedDashboardUrl.value && !dashboardUrl) this.config.dashboardUrl = storedDashboardUrl.value;

    console.log('[Vizora] Config loaded:', this.config);
  }

  private async setupCapacitor() {
    // Setup network status monitoring
    Network.addListener('networkStatusChange', (status) => {
      console.log('[Vizora] Network status changed:', status);
      this.isOnline = status.connected;

      if (status.connected && this.deviceToken && !this.socket?.connected) {
        console.log('[Vizora] Network restored, reconnecting...');
        this.connectToRealtime();
      }
    });

    // Check initial network status
    const status = await Network.getStatus();
    this.isOnline = status.connected;
    console.log('[Vizora] Initial network status:', status);

    // Handle app state changes
    App.addListener('appStateChange', ({ isActive }) => {
      console.log('[Vizora] App state changed, active:', isActive);
      if (isActive && this.deviceToken && !this.socket?.connected) {
        this.connectToRealtime();
      }
      if (!isActive && this.offlineTimeout) {
        clearTimeout(this.offlineTimeout);
        this.offlineTimeout = null;
      }
    });

    // Handle back button (Android TV)
    App.addListener('backButton', () => {
      // Don't exit the app on back button
      console.log('[Vizora] Back button pressed, ignoring...');
    });

    // Setup D-pad navigation
    this.setupDpadNavigation();
  }

  private setupDpadNavigation() {
    // Android TV D-pad key codes
    const KEY_UP = 'ArrowUp';
    const KEY_DOWN = 'ArrowDown';
    const KEY_LEFT = 'ArrowLeft';
    const KEY_RIGHT = 'ArrowRight';
    const KEY_ENTER = 'Enter';
    const KEY_BACK = 'Escape';

    // Remove previous handler if re-initialized
    if (this.dpadHandler) {
      document.removeEventListener('keydown', this.dpadHandler);
    }

    this.dpadHandler = (event: KeyboardEvent) => {
      const focusableElements = document.querySelectorAll('.focusable');
      const currentFocus = document.activeElement;

      switch (event.key) {
        case KEY_UP:
        case KEY_DOWN:
        case KEY_LEFT:
        case KEY_RIGHT:
          // Navigate between focusable elements
          this.handleDpadNavigation(event.key, focusableElements, currentFocus);
          event.preventDefault();
          break;

        case KEY_ENTER:
          // Activate current element
          if (currentFocus && currentFocus instanceof HTMLElement) {
            currentFocus.click();
          }
          event.preventDefault();
          break;

        case KEY_BACK:
          // Don't exit app
          event.preventDefault();
          break;
      }
    };

    document.addEventListener('keydown', this.dpadHandler);
  }

  // Linear D-pad navigation — treats all focusable elements as a flat list.
  // Sufficient for current single-column UI. If the UI gains grid layouts,
  // switch to spatial navigation (nearest element by bounding rect in direction).
  private handleDpadNavigation(
    direction: string,
    elements: NodeListOf<Element>,
    currentFocus: Element | null
  ) {
    if (elements.length === 0) return;

    const elementsArray = Array.from(elements);
    let currentIndex = currentFocus ? elementsArray.indexOf(currentFocus) : -1;

    switch (direction) {
      case 'ArrowUp':
      case 'ArrowLeft':
        currentIndex = currentIndex <= 0 ? elementsArray.length - 1 : currentIndex - 1;
        break;
      case 'ArrowDown':
      case 'ArrowRight':
        currentIndex = currentIndex >= elementsArray.length - 1 ? 0 : currentIndex + 1;
        break;
    }

    const nextElement = elementsArray[currentIndex];
    if (nextElement instanceof HTMLElement) {
      nextElement.focus();
    }
  }

  // ==================== CREDENTIAL MIGRATION ====================

  /**
   * Migrate device credentials from plain Preferences to SecureStorage.
   * Runs once: if credentials exist in Preferences but not in SecureStorage,
   * copies them over and removes the plaintext versions.
   */
  private async migrateCredentialsToSecureStorage() {
    try {
      const secureToken = await SecureStorage.get({ key: 'device_token' });
      if (secureToken.value) return; // Already migrated

      const plainToken = await Preferences.get({ key: 'device_token' });
      const plainDeviceId = await Preferences.get({ key: 'device_id' });

      if (plainToken.value) {
        console.log('[Vizora] Migrating credentials to secure storage...');
        await SecureStorage.set({ key: 'device_token', value: plainToken.value });
        if (plainDeviceId.value) {
          await SecureStorage.set({ key: 'device_id', value: plainDeviceId.value });
        }
        // Remove plaintext credentials
        await Preferences.remove({ key: 'device_token' });
        await Preferences.remove({ key: 'device_id' });
        console.log('[Vizora] Credential migration complete');
      }
    } catch (error) {
      console.error('[Vizora] Credential migration failed:', error);
    }
  }

  // ==================== PAIRING ====================

  private getPairingRetryDelay(): number {
    return Math.min(5000 * Math.pow(2, this.pairingRetryCount), 300000);
  }

  private async startPairing() {
    this.showScreen('pairing');
    this.stopPairingCountdown();
    this.updateStatus('connecting', 'Requesting pairing code...');

    if (!this.isOnline) {
      this.showError('No network connection. Please check your network settings.');
      const delay = this.getPairingRetryDelay();
      this.pairingRetryCount = Math.min(this.pairingRetryCount + 1, 6);
      console.log(`[Vizora] Pairing retry in ${delay}ms (attempt ${this.pairingRetryCount})`);
      setTimeout(() => this.startPairing(), delay);
      return;
    }

    // Reset retry count on fresh online attempt
    this.pairingRetryCount = 0;

    try {
      // Generate a unique device identifier
      const deviceInfo = await this.getDeviceInfo();
      const deviceIdentifier = `android-${deviceInfo.screenWidth}x${deviceInfo.screenHeight}-${Date.now().toString(36)}`;

      console.log('[Vizora] Making pairing request to:', `${this.config.apiUrl}/api/v1/devices/pairing/request`);

      // Use Capacitor's native HTTP for Android
      const response: HttpResponse = await CapacitorHttp.post({
        url: `${this.config.apiUrl}/api/v1/devices/pairing/request`,
        headers: { 'Content-Type': 'application/json' },
        data: {
          deviceIdentifier,
          metadata: deviceInfo,
        },
        connectTimeout: 10000,
        readTimeout: 15000,
      });

      console.log('[Vizora] Pairing response status:', response.status);

      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Failed to request pairing code: ${response.status}`);
      }

      // Unwrap response envelope: { success, data: { code, qrCode, ... } }
      const responseBody = response.data;
      const data = responseBody?.data ?? responseBody;

      if (typeof data?.code !== 'string' || !data.code) {
        throw new Error('Invalid pairing response: missing code');
      }
      if (data.deviceId != null && typeof data.deviceId !== 'string') {
        throw new Error('Invalid pairing response: invalid deviceId');
      }

      console.log('[Vizora] Pairing code received, length:', data.code.length);
      this.pairingCode = data.code;
      this.deviceId = data.deviceId;

      // Track expiry for countdown timer (default 5 minutes if not provided)
      const expiresInSeconds = data.expiresInSeconds || 300;
      this.pairingExpiresAt = Date.now() + expiresInSeconds * 1000;

      // Display the code with countdown
      this.displayPairingCode(data.code);
      this.startPairingCountdown();

      // Generate/display QR code
      if (data.qrCode) {
        this.displayQRCode(data.qrCode);
      } else {
        await this.generateQRCode(data.code);
      }

      // Start polling for pairing completion
      this.startPairingCheck();

      this.updateStatus('connecting', 'Waiting for pairing...');
    } catch (error) {
      console.error('[Vizora] Pairing request failed:', error);
      this.showError('Failed to request pairing code. Retrying...');
      const delay = this.getPairingRetryDelay();
      this.pairingRetryCount = Math.min(this.pairingRetryCount + 1, 6);
      console.log(`[Vizora] Pairing retry in ${delay}ms (attempt ${this.pairingRetryCount})`);
      setTimeout(() => this.startPairing(), delay);
    }
  }

  private displayPairingCode(code: string) {
    const codeElement = document.getElementById('pairing-code');
    if (codeElement) {
      codeElement.textContent = code;
    }
  }

  private startPairingCountdown() {
    if (this.pairingCountdownInterval) {
      clearInterval(this.pairingCountdownInterval);
    }

    const countdownEl = document.getElementById('pairing-countdown');
    if (!countdownEl) return;

    const updateCountdown = () => {
      const remaining = Math.max(0, this.pairingExpiresAt - Date.now());
      const seconds = Math.ceil(remaining / 1000);
      const min = Math.floor(seconds / 60);
      const sec = seconds % 60;
      countdownEl.textContent = `Code expires in ${min}:${sec.toString().padStart(2, '0')}`;

      if (remaining <= 0) {
        countdownEl.textContent = 'Code expired — requesting new code...';
        this.stopPairingCountdown();
      }
    };

    updateCountdown();
    this.pairingCountdownInterval = setInterval(updateCountdown, 1000);
  }

  private stopPairingCountdown() {
    if (this.pairingCountdownInterval) {
      clearInterval(this.pairingCountdownInterval);
      this.pairingCountdownInterval = null;
    }
  }

  private displayQRCode(qrDataUrl: string) {
    const container = document.getElementById('qr-code');
    if (container) {
      const img = document.createElement('img');
      img.src = qrDataUrl;
      img.alt = 'QR Code';
      container.innerHTML = '';
      container.appendChild(img);
    }
  }

  private async generateQRCode(code: string) {
    const container = document.getElementById('qr-code');
    if (!container) return;

    const pairUrl = `${this.config.dashboardUrl}/pair?code=${code}`;

    try {
      const QRCode = await import('qrcode');
      const canvas = document.createElement('canvas');
      await QRCode.toCanvas(canvas, pairUrl, {
        width: 200,
        margin: 1,
        color: { dark: '#000000', light: '#ffffff' },
      });
      container.innerHTML = '';
      container.appendChild(canvas);
    } catch (error) {
      console.error('[Vizora] Failed to generate QR code:', error);
      container.innerHTML = `<div style="color: #888; font-size: 0.8rem; padding: 2rem;">QR unavailable<br>${pairUrl}</div>`;
    }
  }

  private startPairingCheck() {
    if (this.pairingCheckInterval) {
      clearInterval(this.pairingCheckInterval);
    }

    this.pairingCheckInterval = setInterval(async () => {
      if (!this.pairingCode || !this.isOnline) return;

      try {
        // Use Capacitor's native HTTP for Android
        const response: HttpResponse = await CapacitorHttp.get({
          url: `${this.config.apiUrl}/api/v1/devices/pairing/status/${this.pairingCode}`,
          connectTimeout: 10000,
          readTimeout: 10000,
        });

        if (response.status < 200 || response.status >= 300) {
          if (response.status === 404) {
            console.log('[Vizora] Pairing code expired, requesting new one...');
            this.startPairing();
            return;
          }
          throw new Error('Failed to check pairing status');
        }

        // Unwrap response envelope: { success, data: { status, deviceToken, ... } }
        const responseBody = response.data;
        const data = responseBody?.data ?? responseBody;

        if (data.status === 'paired' && typeof data.deviceToken === 'string' && data.deviceToken) {
          console.log('[Vizora] Device paired successfully!');
          this.stopPairingCheck();
          this.stopPairingCountdown();
          this.pairingRetryCount = 0;

          this.deviceToken = data.deviceToken;
          if (typeof data.deviceId === 'string') {
            this.deviceId = data.deviceId;
          }

          // Store credentials in encrypted storage
          await SecureStorage.set({ key: 'device_token', value: data.deviceToken });
          await SecureStorage.set({ key: 'device_id', value: this.deviceId || '' });

          this.connectToRealtime();
        }
      } catch (error) {
        console.error('[Vizora] Pairing check error:', error);
      }
    }, 2000);
  }

  private stopPairingCheck() {
    if (this.pairingCheckInterval) {
      clearInterval(this.pairingCheckInterval);
      this.pairingCheckInterval = null;
    }
  }

  // ==================== HEARTBEAT ====================

  private startHeartbeat() {
    if (this.heartbeatInterval) {
      return;
    }

    console.log('[Vizora] Starting heartbeat (every 15s)');

    // Send first heartbeat immediately
    this.sendHeartbeat();

    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeat();
    }, 15000);
  }

  private stopHeartbeat() {
    if (this.heartbeatInterval) {
      console.log('[Vizora] Stopping heartbeat');
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private sendHeartbeat() {
    if (!this.socket || !this.socket.connected) {
      return;
    }

    try {
      const uptimeSeconds = Math.floor((Date.now() - this.startTime) / 1000);

      // Use browser performance API for memory if available, otherwise defaults
      let memoryUsage = 50; // reasonable default
      const perfMemory = (performance as unknown as { memory?: PerformanceMemory }).memory;
      if (perfMemory && perfMemory.jsHeapSizeLimit) {
        memoryUsage = Math.round((perfMemory.usedJSHeapSize / perfMemory.jsHeapSizeLimit) * 100 * 100) / 100;
      }

      const heartbeatData = {
        uptime: uptimeSeconds,
        appVersion: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '1.0.0',
        metrics: {
          cpuUsage: 0, // not available in browser/WebView context
          memoryUsage,
        },
        currentContent: this.currentContentId
          ? { contentId: this.currentContentId }
          : undefined,
      };

      this.socket.emit('heartbeat', heartbeatData, (response: HeartbeatResponse) => {
        if (response && response.commands) {
          response.commands.forEach((cmd) => this.handleCommand(cmd));
        }
      });
    } catch (error) {
      console.error('[Vizora] Error sending heartbeat:', error);
    }
  }

  // ==================== REALTIME CONNECTION ====================

  private connectToRealtime() {
    if (!this.deviceToken) {
      console.error('[Vizora] No device token available');
      this.startPairing();
      return;
    }

    if (!this.isOnline) {
      console.log('[Vizora] Offline, will retry when network is available');
      this.updateStatus('offline', 'No network connection');
      // Start playback from restored playlist if available
      if (this.currentPlaylist && this.currentPlaylist.items?.length > 0 && !this.playbackTimer) {
        console.log('[Vizora] Starting offline playback from restored playlist');
        this.showScreen('content');
        this.playContent();
      }
      return;
    }

    this.updateStatus('connecting', 'Connecting to server...');

    // Close existing socket if any
    if (this.socket) {
      this.stopHeartbeat();
      if (this.offlineTimeout) {
        clearTimeout(this.offlineTimeout);
        this.offlineTimeout = null;
      }
      this.socket.removeAllListeners();
      this.socket.disconnect();
    }

    this.socket = io(this.config.realtimeUrl, {
      auth: {
        token: this.deviceToken,
      },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 60000,
      randomizationFactor: 0.5,
    });

    this.socket.on('connect', () => {
      console.log('[Vizora] Connected to realtime gateway');
      this.updateStatus('online', 'Connected');
      if (this.offlineTimeout) {
        clearTimeout(this.offlineTimeout);
        this.offlineTimeout = null;
      }
      this.hideOfflineOverlay();
      this.showScreen('content');
      this.startHeartbeat();

      // If we have a restored playlist from offline, start playback while waiting for server update
      if (this.currentPlaylist && this.currentPlaylist.items?.length > 0 && !this.playbackTimer) {
        console.log('[Vizora] Starting playback from restored playlist');
        this.playContent();
      }
    });

    this.socket.on('disconnect', (reason) => {
      console.log('[Vizora] Disconnected:', reason);
      this.updateStatus('offline', 'Disconnected');
      this.stopHeartbeat();
      // Show offline overlay after 60s of sustained disconnect
      if (this.offlineTimeout) {
        clearTimeout(this.offlineTimeout);
      }
      this.offlineTimeout = setTimeout(() => {
        if (!this.socket?.connected) {
          this.showOfflineOverlay();
        }
      }, 60_000);
    });

    this.socket.on('connect_error', async (error) => {
      console.error('[Vizora] Connection error:', error);
      this.updateStatus('offline', 'Connection failed');

      if (error.message.includes('unauthorized') || error.message.includes('invalid token')) {
        console.log('[Vizora] Token invalid, clearing credentials...');
        await SecureStorage.remove({ key: 'device_token' });
        await SecureStorage.remove({ key: 'device_id' });
        this.deviceToken = null;
        this.deviceId = null;
        setTimeout(() => this.startPairing(), 2000);
      }
    });

    this.socket.on('config', (config) => {
      console.log('[Vizora] Received config:', config);
      if (config.qrOverlay) {
        this.renderQrOverlay(config.qrOverlay);
      }
    });

    this.socket.on('playlist:update', (data) => {
      console.log('[Vizora] Received playlist update:', data);
      this.updatePlaylist(data.playlist);
    });

    this.socket.on('command', (command) => {
      console.log('[Vizora] Received command:', command);
      this.handleCommand(command);
    });

    this.socket.on('qr-overlay:update', (data) => {
      console.log('[Vizora] Received QR overlay update:', data);
      this.renderQrOverlay(data.qrOverlay);
    });
  }

  // ==================== PLAYBACK ====================

  private async updatePlaylist(playlist: Playlist) {
    this.currentPlaylist = playlist;
    this.currentIndex = 0;

    // Persist playlist for offline resilience
    try {
      await Preferences.set({ key: 'last_playlist', value: JSON.stringify(playlist) });
    } catch (err) {
      console.warn('[Vizora] Failed to persist playlist:', err);
    }

    if (this.playbackTimer) {
      clearTimeout(this.playbackTimer);
      this.playbackTimer = null;
    }

    const container = document.getElementById('content-container');
    if (container) {
      this.cleanupMediaElements(container);
      container.innerHTML = '';
    }

    if (playlist.items && playlist.items.length > 0) {
      this.showScreen('content');
      this.playContent();
      // Preload upcoming content
      this.preloadContent(playlist.items.slice(0, 5));
    } else {
      console.log('[Vizora] Playlist is empty');
    }
  }

  private async playContent() {
    if (!this.currentPlaylist || !this.currentPlaylist.items) {
      return;
    }

    const items = this.currentPlaylist.items;
    if (items.length === 0) return;

    const currentItem = items[this.currentIndex];
    const container = document.getElementById('content-container');

    if (!container || !currentItem || !currentItem.content) {
      this.nextContent();
      return;
    }

    console.log(`[Vizora] Playing content ${this.currentIndex + 1}/${items.length}: ${currentItem.content.name}`);

    // Track current content for heartbeat reporting
    this.currentContentId = currentItem.content.id;
    this.contentStartTime = Date.now();

    // Emit content impression for analytics
    if (this.socket?.connected) {
      this.socket.emit('content:impression', {
        contentId: currentItem.content.id,
        playlistId: this.currentPlaylist.id,
        timestamp: Date.now(),
      });
    }

    this.cleanupMediaElements(container);
    container.innerHTML = '';

    const contentDiv = document.createElement('div');
    contentDiv.className = 'content-item';

    const contentType = currentItem.content.type;

    // Layout is a special case — it manages its own container
    if (contentType === 'layout') {
      this.renderLayout(currentItem);
      return;
    }

    await this.renderContentToDiv(currentItem.content, contentDiv, {
      useCache: true,
      onVideoEnd: () => this.nextContent(),
      onError: (name) => {
        this.showContentError(container, name);
        setTimeout(() => this.nextContent(), 5000);
      },
    });

    container.appendChild(contentDiv);

    if (contentType !== 'video') {
      const expectedDuration = (currentItem.duration || 10) * 1000;
      this.playbackTimer = setTimeout(() => {
        // Emit completion impression with duration data
        if (this.socket?.connected && this.contentStartTime > 0) {
          const actualDurationMs = Date.now() - this.contentStartTime;
          const completionPercentage = Math.min(100, Math.round((actualDurationMs / expectedDuration) * 100));
          this.socket.emit('content:impression', {
            contentId: currentItem.content!.id,
            playlistId: this.currentPlaylist?.id,
            duration: Math.round(actualDurationMs / 1000),
            completionPercentage,
            timestamp: Date.now(),
          });
        }
        this.nextContent();
      }, expectedDuration);
    }
  }

  private nextContent() {
    if (!this.currentPlaylist || !this.currentPlaylist.items) {
      return;
    }

    // Log completion for video content
    const currentItem = this.currentPlaylist.items[this.currentIndex];
    if (currentItem?.content?.type === 'video' && this.contentStartTime > 0 && this.socket?.connected) {
      const actualDurationMs = Date.now() - this.contentStartTime;
      const expectedDuration = (currentItem.duration || currentItem.content.duration || 30) * 1000;
      const completionPercentage = Math.min(100, Math.round((actualDurationMs / expectedDuration) * 100));
      this.socket.emit('content:impression', {
        contentId: currentItem.content.id,
        playlistId: this.currentPlaylist.id,
        duration: Math.round(actualDurationMs / 1000),
        completionPercentage,
        timestamp: Date.now(),
      });
    }

    this.currentIndex++;

    if (this.currentIndex >= this.currentPlaylist.items.length) {
      if (this.currentPlaylist.loopPlaylist !== false) {
        this.currentIndex = 0;
      } else {
        console.log('[Vizora] Playlist ended');
        return;
      }
    }

    this.playContent();
  }

  private async preloadContent(items: PlaylistItem[]) {
    const tasks = items
      .filter(item => item.content && (item.content.type === 'image' || item.content.type === 'video'))
      .map(async (item) => {
        const content = item.content!;
        const contentUrl = transformContentUrl(content.url, this.config.apiUrl, this.deviceToken);
        const cached = await this.cacheManager.getCachedUri(content.id);
        if (!cached) {
          await this.cacheManager.downloadContent(
            content.id,
            contentUrl,
            content.mimeType || (content.type === 'video' ? 'video/mp4' : 'image/jpeg'),
          );
        }
      });
    await Promise.allSettled(tasks);
  }

  // ==================== COMMANDS ====================

  private async handleCommand(command: { type: string; payload?: Record<string, unknown>; [key: string]: unknown }) {
    switch (command.type) {
      case 'reload':
        window.location.reload();
        break;

      case 'clear_cache':
        await this.cacheManager.clearCache();
        window.location.reload();
        break;

      case 'unpair':
        await SecureStorage.remove({ key: 'device_token' });
        await SecureStorage.remove({ key: 'device_id' });
        window.location.reload();
        break;

      case 'update_config':
        if (command.apiUrl) {
          await Preferences.set({ key: 'config_api_url', value: command.apiUrl as string });
        }
        if (command.realtimeUrl) {
          await Preferences.set({ key: 'config_realtime_url', value: command.realtimeUrl as string });
        }
        if (command.dashboardUrl) {
          await Preferences.set({ key: 'config_dashboard_url', value: command.dashboardUrl as string });
        }
        window.location.reload();
        break;

      case 'push_content':
        if (command.payload?.content != null) {
          const content = command.payload.content as PushContent;
          const duration = (command.payload.duration as number) || 5;
          this.handleContentPush(content, duration);
        } else {
          console.warn('[Vizora] push_content command missing content payload');
        }
        break;

      case 'qr-overlay-update':
        this.renderQrOverlay(command.payload?.config as QrOverlayConfig | undefined);
        break;

      default:
        console.warn('[Vizora] Unknown command:', command.type);
    }
  }

  // ==================== TEMPORARY CONTENT PUSH ====================

  private handleContentPush(content: PushContent, duration: number = 5) {
    console.log(`[Vizora] Pushing content: ${content.name} for ${duration} min`);

    // Save current playlist state if playing
    if (this.currentPlaylist && !this.temporaryContent) {
      this.savedPlaylistState = {
        playlist: this.currentPlaylist,
        index: this.currentIndex,
      };
    }

    // Clear current playback timer
    if (this.playbackTimer) {
      clearTimeout(this.playbackTimer);
      this.playbackTimer = null;
    }

    // Clear any existing temporary content timer
    if (this.temporaryContentTimer) {
      clearTimeout(this.temporaryContentTimer);
      this.temporaryContentTimer = null;
    }

    // Show temporary content
    this.temporaryContent = content;
    this.renderTemporaryContent(content).catch(err =>
      console.error('[Vizora] Error rendering temporary content:', err)
    );

    // Set timer to resume playlist after duration (convert minutes to ms)
    this.temporaryContentTimer = setTimeout(() => {
      this.resumePlaylist();
    }, duration * 60 * 1000);
  }

  private async renderTemporaryContent(content: PushContent) {
    const container = document.getElementById('content-container');
    if (!container) return;

    this.cleanupMediaElements(container);
    while (container.firstChild) container.removeChild(container.firstChild);

    const contentDiv = document.createElement('div');
    contentDiv.className = 'content-item';

    // Track current content for heartbeat reporting
    this.currentContentId = content.id;

    // Emit content impression for analytics
    if (this.socket?.connected) {
      this.socket.emit('content:impression', {
        contentId: content.id,
        timestamp: Date.now(),
      });
    }

    await this.renderContentToDiv(content, contentDiv, {
      useCache: true,
      onVideoEnd: () => {
        if (this.temporaryContent) this.resumePlaylist();
      },
      onError: (name) => this.showContentError(container, name),
    });

    container.appendChild(contentDiv);
    this.showScreen('content');
  }

  private showContentError(container: HTMLElement, contentName: string) {
    while (container.firstChild) container.removeChild(container.firstChild);
    const errorDiv = document.createElement('div');
    errorDiv.style.cssText = 'display:flex;align-items:center;justify-content:center;width:100%;height:100%;background:#111;color:#888;font-family:sans-serif;font-size:24px;text-align:center;padding:40px;';
    errorDiv.textContent = `Unable to load: ${contentName}`;
    container.appendChild(errorDiv);
  }

  private resumePlaylist() {
    console.log('[Vizora] Resuming playlist after temporary content');

    // Clear temporary content state
    this.temporaryContent = null;
    if (this.temporaryContentTimer) {
      clearTimeout(this.temporaryContentTimer);
      this.temporaryContentTimer = null;
    }

    // Restore playlist state
    if (this.savedPlaylistState) {
      this.currentPlaylist = this.savedPlaylistState.playlist;
      this.currentIndex = this.savedPlaylistState.index;
      this.savedPlaylistState = null;
      this.playContent();
    } else {
      // No playlist was playing, just clear the screen
      const container = document.getElementById('content-container');
      if (container) {
        this.cleanupMediaElements(container);
        container.innerHTML = '';
      }
    }
  }

  // ==================== QR OVERLAY ====================

  private async renderQrOverlay(config: QrOverlayConfig | undefined) {
    const overlay = document.getElementById('qr-overlay');
    if (!overlay) return;

    if (!config || !config.enabled) {
      overlay.classList.add('hidden');
      while (overlay.firstChild) overlay.removeChild(overlay.firstChild);
      return;
    }
    overlay.innerHTML = '';
    overlay.className = config.position || 'bottom-right';
    overlay.style.backgroundColor = config.backgroundColor || '#ffffff';
    overlay.style.opacity = String(config.opacity ?? 1);

    const margin = config.margin || 16;
    overlay.style.position = 'fixed';
    overlay.style.zIndex = '100';
    // Reset all positions first
    overlay.style.top = 'auto';
    overlay.style.bottom = 'auto';
    overlay.style.left = 'auto';
    overlay.style.right = 'auto';

    if (config.position === 'top-left') { overlay.style.top = margin + 'px'; overlay.style.left = margin + 'px'; }
    else if (config.position === 'top-right') { overlay.style.top = margin + 'px'; overlay.style.right = margin + 'px'; }
    else if (config.position === 'bottom-left') { overlay.style.bottom = margin + 'px'; overlay.style.left = margin + 'px'; }
    else { overlay.style.bottom = margin + 'px'; overlay.style.right = margin + 'px'; }

    const size = config.size || 120;
    try {
      const QRCode = await import('qrcode');
      const canvas = document.createElement('canvas');
      await QRCode.toCanvas(canvas, config.url, {
        width: size,
        margin: 1,
        color: { dark: '#000000', light: config.backgroundColor || '#ffffff' },
      });
      overlay.appendChild(canvas);

      if (config.label) {
        const label = document.createElement('div');
        label.style.cssText = 'font-size:10px;color:#333;text-align:center;max-width:' + size + 'px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        label.textContent = config.label;
        overlay.appendChild(label);
      }

      overlay.classList.remove('hidden');
    } catch (err) {
      console.error('[Vizora] QR code generation failed:', err);
    }
  }

  // ==================== MULTI-ZONE LAYOUT ====================

  private renderLayout(content: PlaylistItem) {
    const container = document.getElementById('content-container');
    if (!container) return;

    const raw = content as unknown as Record<string, unknown>;
    const contentRecord = content.content as unknown as Record<string, unknown> | null;
    const metadata = (raw.metadata || contentRecord?.metadata) as LayoutMetadata | undefined;
    if (!metadata || !metadata.zones) return;

    this.cleanupLayout();

    const grid = document.createElement('div');
    grid.className = 'layout-grid';
    grid.style.cssText = 'width:100%;height:100%;display:grid;overflow:hidden;';
    if (metadata.gridTemplate) {
      grid.style.gridTemplateColumns = metadata.gridTemplate.columns || '1fr';
      grid.style.gridTemplateRows = metadata.gridTemplate.rows || '1fr';
    }
    if (metadata.gap) grid.style.gap = metadata.gap + 'px';
    if (metadata.backgroundColor) grid.style.backgroundColor = metadata.backgroundColor;

    for (const zone of metadata.zones) {
      const zoneDiv = document.createElement('div');
      zoneDiv.className = 'layout-zone';
      zoneDiv.style.cssText = 'position:relative;overflow:hidden;grid-area:' + zone.gridArea + ';';

      if (zone.resolvedPlaylist?.items && zone.resolvedPlaylist.items.length > 0) {
        this.createZonePlayer(zone.id, zone.resolvedPlaylist, zoneDiv);
      } else if (zone.resolvedContent) {
        this.renderZoneContent(zone.resolvedContent, zoneDiv);
      }

      grid.appendChild(zoneDiv);
    }

    this.cleanupMediaElements(container);
    container.innerHTML = '';
    container.appendChild(grid);
  }

  private createZonePlayer(zoneId: string, playlist: Playlist, container: HTMLElement) {
    this.zoneIndices.set(zoneId, 0);

    const playZoneItem = () => {
      // Guard: stop if zone was cleaned up during timer wait
      if (!this.zoneIndices.has(zoneId)) return;

      const index = this.zoneIndices.get(zoneId) || 0;
      const items = playlist.items;
      if (!items || items.length === 0) return;
      const item = items[index % items.length];
      if (!item?.content) return;

      this.renderZoneContent(item.content, container);
      const duration = (item.duration || item.content.duration || 10) * 1000;
      const timer = setTimeout(() => {
        this.zoneIndices.set(zoneId, (index + 1) % items.length);
        playZoneItem();
      }, duration);
      this.zoneTimers.set(zoneId, timer);
    };

    playZoneItem();
  }

  private renderZoneContent(content: NonNullable<PlaylistItem['content']>, container: HTMLElement) {
    this.cleanupMediaElements(container);
    while (container.firstChild) container.removeChild(container.firstChild);
    const contentDiv = document.createElement('div');
    contentDiv.className = 'content-item';

    // Zone content uses cache and plays video muted+looping
    this.renderContentToDiv(content, contentDiv, {
      useCache: true,
      muteVideo: true,
      loopVideo: true,
    });

    container.appendChild(contentDiv);
  }

  private cleanupLayout() {
    for (const [, timer] of this.zoneTimers) clearTimeout(timer);
    this.zoneTimers.clear();
    this.zoneIndices.clear();
  }

  // ==================== HTML CONTENT SECURITY ====================

  /**
   * Injects a Content-Security-Policy meta tag into HTML content.
   * Security model: iframe sandbox (allow-scripts only) + restrictive CSP.
   * This does NOT sanitize HTML — it relies on CSP to block network access
   * and sandbox to prevent parent DOM access.
   */
  private injectContentSecurityPolicy(html: string): string {
    return injectContentSecurityPolicy(html);
  }

  // ==================== SHARED CONTENT RENDERER ====================

  /**
   * Renders a content element into a container. Used by playlist playback,
   * temporary push content, and multi-zone layout to avoid triplicated logic.
   */
  private async renderContentToDiv(
    content: { id: string; name: string; type: string; url: string; mimeType?: string },
    contentDiv: HTMLElement,
    options?: {
      useCache?: boolean;
      onVideoEnd?: () => void;
      onError?: (contentName: string) => void;
      muteVideo?: boolean;
      loopVideo?: boolean;
    },
  ): Promise<void> {
    const contentType = content.type;
    const useCache = options?.useCache ?? true;

    // Transform URL (skip for HTML/template which contain raw markup)
    const contentUrl = (contentType === 'html' || contentType === 'template')
      ? content.url
      : transformContentUrl(content.url, this.config.apiUrl, this.deviceToken);

    // Resolve through cache for media content
    let resolvedUrl = contentUrl;
    if (useCache && (contentType === 'image' || contentType === 'video')) {
      try {
        const cachedUri = await this.cacheManager.getCachedUri(content.id);
        if (cachedUri) {
          resolvedUrl = cachedUri;
        } else {
          const downloaded = await this.cacheManager.downloadContent(
            content.id,
            contentUrl,
            content.mimeType || (contentType === 'video' ? 'video/mp4' : 'image/jpeg'),
          );
          if (downloaded) {
            resolvedUrl = downloaded;
          }
        }
      } catch {
        // Fall through to use direct URL
      }
    }

    const handleError = () => {
      if (options?.onError) options.onError(content.name);
    };

    switch (contentType) {
      case 'image': {
        const img = document.createElement('img');
        img.src = resolvedUrl;
        img.alt = content.name;
        img.onerror = handleError;
        contentDiv.appendChild(img);
        break;
      }
      case 'video': {
        const video = document.createElement('video');
        video.src = resolvedUrl;
        video.autoplay = true;
        video.muted = options?.muteVideo ?? false;
        video.playsInline = true;
        if (options?.loopVideo) video.loop = true;
        video.setAttribute('x5-video-player-type', 'h5');
        video.setAttribute('x5-video-player-fullscreen', 'true');
        video.onerror = handleError;
        if (options?.onVideoEnd) video.onended = options.onVideoEnd;
        contentDiv.appendChild(video);
        break;
      }
      case 'webpage':
      case 'url': {
        const iframe = document.createElement('iframe');
        iframe.src = contentUrl;
        iframe.allow = 'autoplay; fullscreen';
        iframe.style.cssText = 'width:100%;height:100%;border:none;';
        iframe.onerror = handleError;
        contentDiv.appendChild(iframe);
        break;
      }
      case 'html':
      case 'template': {
        const iframe = document.createElement('iframe');
        iframe.sandbox.add('allow-scripts');
        iframe.srcdoc = this.injectContentSecurityPolicy(content.url);
        iframe.style.cssText = 'width:100%;height:100%;border:none;';
        // onerror doesn't fire for srcdoc iframes; use load timeout as fallback
        const loadTimer = setTimeout(() => handleError(), 10_000);
        iframe.onload = () => clearTimeout(loadTimer);
        contentDiv.appendChild(iframe);
        break;
      }
      default:
        console.warn('[Vizora] Unknown content type:', contentType);
    }
  }

  // ==================== MEDIA CLEANUP ====================

  private cleanupMediaElements(container: HTMLElement) {
    const videos = container.querySelectorAll('video');
    videos.forEach(video => {
      video.pause();
      video.removeAttribute('src');
      video.load(); // forces release of media resources
    });
  }

  // ==================== UI HELPERS ====================

  private showScreen(screen: 'loading' | 'pairing' | 'content' | 'error') {
    const screens = ['loading-screen', 'pairing-screen', 'content-screen', 'error-screen'];
    screens.forEach((id) => {
      const el = document.getElementById(id);
      if (el) {
        el.classList.toggle('hidden', id !== `${screen}-screen`);
      }
    });
  }

  private showError(message: string) {
    const errorMessage = document.getElementById('error-message');
    if (errorMessage) {
      errorMessage.textContent = message;
    }
    this.showScreen('error');
  }

  private showOfflineOverlay() {
    const existing = document.getElementById('offline-overlay');
    if (existing) return;
    const overlay = document.createElement('div');
    overlay.id = 'offline-overlay';
    overlay.style.cssText = 'position:fixed;bottom:0;left:0;right:0;background:rgba(0,0,0,0.8);color:#fff;text-align:center;padding:16px;z-index:9999;font-size:18px;';
    overlay.textContent = 'Device is offline — reconnecting...';
    document.body.appendChild(overlay);
  }

  private hideOfflineOverlay() {
    const overlay = document.getElementById('offline-overlay');
    if (overlay) overlay.remove();
  }

  private updateStatus(status: 'online' | 'offline' | 'connecting', text: string) {
    const dot = document.getElementById('status-dot');
    const statusText = document.getElementById('status-text');

    if (dot) {
      dot.className = 'status-dot ' + status;
    }
    if (statusText) {
      statusText.textContent = text;
    }
  }

  private async getDeviceInfo() {
    // Get network info
    const networkStatus = await Network.getStatus();

    return {
      platform: 'android_tv',
      userAgent: navigator.userAgent,
      language: navigator.language,
      screenWidth: window.screen.width,
      screenHeight: window.screen.height,
      colorDepth: window.screen.colorDepth,
      pixelRatio: window.devicePixelRatio,
      networkType: networkStatus.connectionType,
      timestamp: new Date().toISOString(),
    };
  }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => new VizoraAndroidTV());
} else {
  new VizoraAndroidTV();
}
