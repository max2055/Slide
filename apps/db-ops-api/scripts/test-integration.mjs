#!/usr/bin/env node
/**
 * Slide Integration Test
 *
 * 验证完整集成：
 * 1. DirectAdapter 运行在 28888
 * 2. Slide API 运行在 3000
 * 3. 前端可以通过 Vite 代理访问 API
 * 4. 工具可以通过 API 调用
 */

import { spawn } from "node:child_process";

const TESTS = [
  {
    name: "DirectAdapter Health",
    url: "http://127.0.0.1:28888/health",
    expected: (data) => data.ok === true,
  },
  {
    name: "Slide API Health",
    url: "http://localhost:3000/api/health",
    expected: (data) => data.status === "ok",
  },
  {
    name: "Slide API - Database Instances",
    url: "http://localhost:3000/api/database/instances",
    expected: (data) => Array.isArray(data.instances),
  },
  {
    name: "Slide API - Capacity Endpoint",
    url: "http://localhost:3000/api/database/instances/1/capacity",
    expected: (data) => data.instance_id === 1,
  },
  {
    name: "Vite Proxy - Frontend to API",
    url: "http://localhost:5173/api/health",
    expected: (data) => data.status === "ok",
  },
];

async function runTest(test) {
  try {
    const response = await fetch(test.url);
    if (!response.ok) {
      return { pass: false, error: `HTTP ${response.status}` };
    }
    const data = await response.json();
    const pass = test.expected(data);
    return { pass, data: pass ? null : data };
  } catch (error) {
    return { pass: false, error: error.message };
  }
}

async function main() {
  console.log("🧪 Slide Integration Test\n");

  let passed = 0;
  let failed = 0;

  for (const test of TESTS) {
    process.stdout.write(`  ${test.name} ... `);
    const result = await runTest(test);

    if (result.pass) {
      console.log("✅ PASS");
      passed++;
    } else {
      console.log("❌ FAIL");
      if (result.error) {
        console.log(`     Error: ${result.error}`);
      } else {
        console.log(`     Data: ${JSON.stringify(result.data)}`);
      }
      failed++;
    }
  }

  console.log("\n" + "=".repeat(50));
  console.log(`Results: ${passed} passed, ${failed} failed`);

  if (failed === 0) {
    console.log("\n🎉 All tests passed! Integration is working correctly.");
    process.exit(0);
  } else {
    console.log("\n⚠️  Some tests failed. Check the services.");
    process.exit(1);
  }
}

main();
