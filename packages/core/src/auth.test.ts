import { describe, expect, it } from 'vitest';

import { authEmailForEmployee, PDA_AUTH_DOMAIN } from './auth';

describe('authEmailForEmployee', () => {
  it('แปลงรหัสพนักงานมาตรฐาน', () => {
    expect(authEmailForEmployee('EMP-2041')).toBe(`emp2041@${PDA_AUTH_DOMAIN}`);
  });

  it('รูปแบบที่พิมพ์ต่างกันต้องเข้าบัญชีเดียวกัน', () => {
    const expected = `emp2041@${PDA_AUTH_DOMAIN}`;
    for (const input of ['EMP-2041', 'emp2041', ' EMP 2041 ', 'Emp_2041']) {
      expect(authEmailForEmployee(input)).toBe(expected);
    }
  });

  it('รับโดเมนอื่นได้', () => {
    expect(authEmailForEmployee('EMP-1', 'test.local')).toBe('emp1@test.local');
  });

  it('รหัสที่ไม่มีตัวอักษรหรือตัวเลขเลยต้อง error ไม่ใช่คืนอีเมลพัง', () => {
    expect(() => authEmailForEmployee('---')).toThrow();
    expect(() => authEmailForEmployee('   ')).toThrow();
  });
});
