import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'co.anin.cyclecount',
  appName: 'Cycle Count',
  webDir: 'dist',
  // online-only: ถ้าต้องการให้แอปโหลด UI จาก server โดยตรง ให้ตั้ง server.url
  // server: { url: 'https://<web-app>.vercel.app', cleartext: false },
  android: {
    // อนุญาต http สำหรับ dev เท่านั้น (production ใช้ https)
    allowMixedContent: true,
  },
};

export default config;
