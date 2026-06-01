/**
 * Oracle Instance Form -- source structure test (GAP-09 / D-12)
 *
 * Verifies that instances-db.ts conditionally shows the Oracle database
 * identifier field (SID/Service Name) when db_type === 'oracle'.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const INSTANCES_DB_PATH = path.resolve(__dirname, '../instances-db.ts');
const source = fs.readFileSync(INSTANCES_DB_PATH, 'utf-8');

describe('GAP-09 / D-12: Oracle database identifier form field', () => {
  it('表单应包含 db_type === "oracle" 条件渲染逻辑', () => {
    expect(source).toContain("db_type === 'oracle'");
  });

  it('条件渲染应修改 label 为 Oracle 数据库标识', () => {
    expect(source).toContain('Oracle 数据库标识');
  });

  it('条件渲染应提及 SID/Service Name', () => {
    expect(source).toContain('SID/Service Name');
  });

  it('条件渲染提示信息应提及 Easy Connect', () => {
    expect(source).toContain('Easy Connect');
  });
});
