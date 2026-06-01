/**
 * 意图检测 API 测试脚本
 */

const API_BASE_URL = 'http://localhost:3000';

const testMessages = [
  '帮我查看数据库健康状态',
  '分析一下这个 SQL 的性能',
  '生成一个周报',
  '设置数据库监控',
  '先检查状态，然后分析问题',
  '为什么这个查询这么慢？',
  '列出所有生产环境的实例',
  '有什么告警吗？'
];

async function testIntentDetection() {
  console.log('='.repeat(60));
  console.log('意图检测 API 测试');
  console.log('='.repeat(60));

  // 测试意图检测接口
  console.log('\n1️⃣  测试 /api/intent/detect 接口');
  console.log('-'.repeat(40));

  for (const message of testMessages) {
    try {
      const response = await fetch(`${API_BASE_URL}/api/intent/detect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message })
      });

      const data = await response.json();

      if (data.detected) {
        console.log(`✓ "${message}"`);
        console.log(`  意图：${data.intent.type} (${(data.intent.confidence * 100).toFixed(0)}%)`);
        console.log(`  技能：${data.intent.skillName}`);
        console.log(`  工具：${data.intent.relatedTools.join(', ')}`);
      } else {
        console.log(`✗ "${message}" - ${data.message || '未检测到意图'}`);
      }
    } catch (error: any) {
      console.log(`⚠ "${message}" - 请求失败：${error.message}`);
    }
  }

  // 测试增强版聊天接口（带意图检测）
  console.log('\n2️⃣  测试 /api/chat/enhanced 接口（带意图检测）');
  console.log('-'.repeat(40));

  const testMessage = '帮我查看数据库健康状态';
  try {
    const response = await fetch(`${API_BASE_URL}/api/chat/enhanced`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: testMessage,
        detectIntent: true
      })
    });

    const data = await response.json();

    console.log(`用户：${testMessage}`);
    console.log(`AI 回复：${data.response?.slice(0, 100) || '无'}...`);

    if (data.intentSuggestion) {
      console.log('\n🚀 意图检测建议：');
      console.log(`  技能名称：${data.intentSuggestion.skill.name}`);
      console.log(`  描述：${data.intentSuggestion.skill.description}`);
      console.log(`  置信度：${(data.intentSuggestion.intent.confidence * 100).toFixed(0)}%`);
    } else {
      console.log('\n无意图检测建议');
    }
  } catch (error: any) {
    console.log(`⚠ 请求失败：${error.message}`);
  }

  // 测试创建技能
  console.log('\n3️⃣  测试 /api/skills/create 接口');
  console.log('-'.repeat(40));

  try {
    const response = await fetch(`${API_BASE_URL}/api/skills/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'test_quick_skill',
        description: '帮我查看数据库健康状态',
        source: 'manual'
      })
    });

    const data = await response.json();

    if (data.success) {
      console.log('✓ 技能创建成功');
      console.log(`  名称：${data.skill.name}`);
      console.log(`  描述：${data.skill.description}`);
      console.log(`  工具：${data.skill.tools.join(', ')}`);
    } else {
      console.log(`✗ 技能创建失败：${data.error}`);
    }
  } catch (error: any) {
    console.log(`⚠ 请求失败：${error.message}`);
  }

  // 测试列出技能
  console.log('\n4️⃣  测试 /api/skills 接口');
  console.log('-'.repeat(40));

  try {
    const response = await fetch(`${API_BASE_URL}/api/skills`);
    const data = await response.json();

    console.log(`已生成的技能数量：${data.total}`);
    if (data.skills.length > 0) {
      data.skills.forEach((skill: any) => {
        console.log(`  - ${skill.name}: ${skill.description} (${skill.source})`);
      });
    }
  } catch (error: any) {
    console.log(`⚠ 请求失败：${error.message}`);
  }

  console.log('\n' + '='.repeat(60));
  console.log('测试完成！');
  console.log('='.repeat(60));
}

// 运行测试
testIntentDetection().catch(console.error);
