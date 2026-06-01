/**
 * Skill Generator 测试
 *
 * 测试意图检测、模式挖掘、技能合成和动态注册功能
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { IntentDetector } from './skill-generator/intent-detector.js';
import { PatternMiner } from './skill-generator/pattern-miner.js';
import { SkillSynth } from './skill-generator/skill-synth.js';
import { DynamicSkillRegistry } from './skill-generator/dynamic-registry.js';

describe('Skill Generator', () => {
  describe('IntentDetector', () => {
    const detector = new IntentDetector();

    it('应该检测到重复性任务意图', () => {
      const intent = detector.detect('帮我查看数据库健康状态');
      expect(intent).not.toBeNull();
      expect(intent?.type).toBe('repeatable_task');
      expect(intent?.suggestedSkillName).toContain('check');
    });

    it('应该检测到分析类任务意图', () => {
      const intent = detector.detect('分析一下这个 SQL 的性能');
      expect(intent).not.toBeNull();
      expect(intent?.type).toBe('analysis');
      expect(intent?.suggestedSkillName).toContain('analyze');
    });

    it('应该检测到报告生成意图', () => {
      const intent = detector.detect('生成一个周报');
      expect(intent).not.toBeNull();
      expect(intent?.type).toBe('report');
      expect(intent?.suggestedSkillName).toContain('generate');
    });

    it('应该检测到监控类任务意图', () => {
      const intent = detector.detect('设置数据库监控');
      expect(intent).not.toBeNull();
      expect(intent?.type).toBe('monitoring');
      expect(intent?.suggestedSkillName).toContain('monitor');
    });

    it('应该基于历史检测到重复请求', () => {
      const history = [
        { role: 'user' as const, content: '帮我检查数据库状态' },
        { role: 'user' as const, content: '再次检查数据库状态' }
      ];

      const intent = detector.detect('帮我检查数据库状态', { history });
      expect(intent).not.toBeNull();
      expect(intent?.confidence).toBeGreaterThan(0.8);
    });
  });

  describe('PatternMiner', () => {
    const miner = new PatternMiner({ windowSize: 50, persistToDb: false });

    it('应该记录工具执行', () => {
      const record = {
        toolName: 'db_list_instances',
        params: { status: 'active' },
        result: { success: true },
        success: true,
        duration: 100,
        timestamp: Date.now(),
        sessionId: 'test-session-1'
      };

      miner.recordExecution(record);
      const stats = miner.getStats();
      expect(stats.totalExecutions).toBe(1);
    });

    it('应该检测到频繁的工具序列', async () => {
      // 记录相同的工具序列 3 次
      const sessionId = 'test-session-sequence';
      const sequence = ['db_list_instances', 'db_check_health', 'db_get_metrics'];

      for (let i = 0; i < 3; i++) {
        for (const toolName of sequence) {
          await miner.recordExecution({
            toolName,
            params: {},
            result: { success: true },
            success: true,
            duration: 100,
            timestamp: Date.now(),
            sessionId: `${sessionId}-${i}`
          });
        }
      }

      const patterns = miner.detectAutomatablePatterns();
      const foundPattern = patterns.find(p =>
        p.sequence.includes('db_list_instances') &&
        p.sequence.includes('db_check_health')
      );

      expect(foundPattern).toBeDefined();
      expect(foundPattern!.frequency).toBeGreaterThanOrEqual(3);
      expect(foundPattern!.successRate).toBeGreaterThan(0.8);
    });
  });

  describe('SkillSynth', () => {
    const synth = new SkillSynth();

    it('应该基于意图生成技能', () => {
      const intent = {
        type: 'repeatable_task' as const,
        confidence: 0.8,
        pattern: 'check_health',
        slots: { metric: 'health' },
        suggestedSkillName: 'check_db_health',
        suggestedDescription: '检查数据库健康状态',
        relatedTools: ['db_check_health', 'db_get_metrics']
      };

      const skill = synth.synthesizeFromIntent(intent);

      expect(skill.name).toBe('check_db_health');
      expect(skill.description).toContain('健康');
      expect(skill.tools.length).toBeGreaterThan(0);
      expect(skill.skillMarkdown).toContain('check_db_health');
      expect(skill.toolCode).toContain('check_db_health');
    });

    it('应该基于模式生成技能', () => {
      const pattern = {
        id: 'test_pattern',
        tools: ['db_list_instances', 'db_check_health'],
        sequence: ['db_list_instances', 'db_check_health'],
        frequency: 5,
        avgExecutionTime: 500,
        successRate: 0.95,
        context: {}
      };

      const skill = synth.synthesizeFromPattern(pattern);

      expect(skill.name).toContain('workflow');
      expect(skill.description).toContain('自动化工作流');
      expect(skill.tools.length).toBe(1);
      expect(skill.skillMarkdown).toContain('工作流程');
    });
  });

  describe('DynamicSkillRegistry', () => {
    const registry = new DynamicSkillRegistry(process.cwd());

    beforeAll(async () => {
      await registry.initialize();
    });

    it('应该注册技能', async () => {
      const synth = new SkillSynth();
      const intent = {
        type: 'repeatable_task' as const,
        confidence: 0.8,
        pattern: 'test',
        slots: {},
        suggestedSkillName: 'test_quick_skill',
        suggestedDescription: '测试技能',
        relatedTools: ['db_list_instances']
      };

      const generatedSkill = synth.synthesizeFromIntent(intent);

      const mockApi = {
        logger: console,
        registerTool: () => {}
      };

      const result = await registry.registerSkill(generatedSkill, mockApi, 'manual');

      expect(result.success).toBe(true);
      expect(registry.hasSkill('test_quick_skill')).toBe(true);
    });

    it('应该列出已注册的技能', () => {
      const skills = registry.listGeneratedSkills();
      expect(skills.length).toBeGreaterThan(0);
      expect(skills.some(s => s.name === 'test_quick_skill')).toBe(true);
    });

    it('应该删除技能', async () => {
      const result = await registry.unregisterSkill('test_quick_skill');
      expect(result.success).toBe(true);
      expect(registry.hasSkill('test_quick_skill')).toBe(false);
    });
  });
});
