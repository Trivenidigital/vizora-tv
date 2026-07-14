# Vizora on Samsung TVs — Deployment Guide

**For:** Customers running (or planning to run) Vizora signage on Samsung Smart TVs.
**Last updated:** 2026-04-24
**Status:** Interim deployment guidance until the native Tizen app ships (roadmap).

---

## TL;DR

Plug a ~$50 Android TV streaming device into your Samsung TV's HDMI port and install the Vizora app on the streamer. The Samsung TV becomes the display; the streaming device runs Vizora. Setup takes about 10 minutes and nothing changes about how you manage Vizora afterward.

## Why This Approach

- **A native Vizora app for Samsung TVs is on the roadmap** but not yet listed in the Samsung App Store. Samsung's review process is multi-month; we are not asking you to wait.
- **Android TV streaming devices are purpose-built for this use case** — they auto-launch apps on boot, run 24/7 reliably, and Vizora's Android TV app is production-tested and available today.
- **This is the industry-standard pattern.** Competitors (ScreenCloud, Yodeck, Rise Vision) deploy on Samsung TVs the same way. The TV is "just a monitor" with HDMI input.

## Recommended Hardware

> Pricing and availability shift; verify current SKUs before bulk-purchasing.

### Primary: Onn 4K Pro Streaming Box (~$50, Walmart)
- **Wired ethernet port** — the single most important feature for 24/7 signage reliability
- USB-A port for accessories
- Android TV 12+, 4K HDR, remote included
- **Best choice for production signage deployments.**

### Premium: Google TV Streamer 4K (~$99, Google Store / major retailers)
- Wired ethernet port
- Newer Google flagship; longer support window
- Strong brand fit for customers who want first-party Google hardware
- **Best choice when budget allows or when standardizing across a large fleet.**

### Budget: Onn 4K Streaming Stick (~$20, Walmart)
- WiFi only, stick form factor (hides behind TV)
- Acceptable for pilots, temporary installs, or low-criticality screens
- **Not recommended for production unless cost is decisive** — WiFi-only deployments see meaningfully higher disconnect rates.

## Setup (≈10 minutes per screen)

1. Plug the streaming device into the Samsung TV's HDMI port and connect power.
2. On the Samsung remote, switch the TV's input to that HDMI source.
3. Connect the streamer to the network — wired ethernet on the Onn 4K Pro / Google TV Streamer, otherwise WiFi.
4. Open Google Play on the streamer, search **"Vizora Display,"** install.
5. Launch Vizora. A pairing QR code displays on screen — scan it from your Vizora dashboard to claim the device. Done.

After setup, the streamer auto-launches Vizora on every power-on. For always-on signage, leave both the TV and streamer powered continuously.

## Frequently Asked Questions

**Q: Can I install Vizora directly on my Samsung TV instead?**
A: Not yet. The native Tizen app is on our roadmap. The Android TV streamer is the supported deployment today.

**Q: Do I need a separate streamer for every TV?**
A: Yes. Each display needs its own player; one streamer drives one TV.

**Q: When the native Samsung app ships, can I migrate?**
A: Yes. Devices are paired by Vizora account, not by hardware. When the Tizen app is available, you can install it directly on the TV and unpair the streamer with no content loss.

**Q: Can I use an Android TV device I already own?**
A: Yes, if it runs Android TV 8.0+ and has the Google Play Store. The recommendations above are tested and supported; other devices should work but are not formally validated.

**Q: What about LG, Sony, Hisense, or other Smart TVs?**
A: Same approach. The streamer is brand-agnostic; the TV only needs an HDMI input.

**Q: How does the TV stay on without burn-in or screen timeout interrupting content?**
A: Configure the Samsung TV's sleep timer to "Off" (Settings → General → System Manager → Time → Sleep Timer). Modern Samsung TVs use OLED or QLED panels with built-in pixel-shift protections — burn-in risk is minimal for typical signage rotation but increases for fully static content shown 24/7. For static content, rotate the layout periodically.

**Q: What if the TV gets unplugged or loses power?**
A: When power returns, the Samsung TV will resume on its last input (the streamer's HDMI), the streamer auto-boots, and Vizora auto-launches with cached content. No manual intervention required.

## Support

- **Setup help:** support@vizora.io — include the device serial number from Settings → About on the streamer.
- **Bulk deployments (10+ screens):** sales@vizora.io — we can help spec hardware and discuss volume pricing on streamers.
