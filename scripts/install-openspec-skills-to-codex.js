#!/usr/bin/env node
/**
 * 从官方仓库 partme-ai/openspec-skills 下载全部 15 个 skill，安装到 Codex 全局 skills 目录。
 * 目标目录：$CODEX_HOME/skills（默认 ~/.codex/skills）
 * 依赖：已安装 git。使用：node scripts/install-openspec-skills-to-codex.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const REPO = 'https://github.com/partme-ai/openspec-skills.git';

const CODEX_HOME = process.env.CODEX_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.codex');
const CODEX_SKILLS_DIR = path.join(CODEX_HOME, 'skills');

const copyDir = (src, dest) => {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const srcPath = path.join(src, name);
    const destPath = path.join(dest, name);
    if (fs.statSync(srcPath).isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
};

const run = () => {
  const tmpDir = path.join(os.tmpdir(), `openspec-skills-${Date.now()}`);
  const skillsSrc = path.join(tmpDir, 'skills');

  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    console.log('正在克隆 partme-ai/openspec-skills（仅 skills 目录）...');
    execSync(`git clone --depth 1 --filter=blob:none --sparse "${REPO}" "${tmpDir}"`, {
      stdio: 'inherit',
      shell: true,
    });
    execSync('git sparse-checkout set skills', { cwd: tmpDir, stdio: 'inherit', shell: true });

    if (!fs.existsSync(skillsSrc)) throw new Error('仓库中未找到 skills 目录');

    fs.mkdirSync(CODEX_SKILLS_DIR, { recursive: true });
    console.log('Codex skills 目录:', CODEX_SKILLS_DIR);
    const names = fs.readdirSync(skillsSrc);
    let count = 0;
    for (const name of names) {
      const src = path.join(skillsSrc, name);
      if (!fs.statSync(src).isDirectory()) continue;
      const dest = path.join(CODEX_SKILLS_DIR, name);
      copyDir(src, dest);
      console.log('已安装:', name);
      count++;
    }
    console.log('\n共安装', count, '个 skill。请重启 Codex 以加载新 skill。');
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  }
};

try {
  run();
} catch (err) {
  console.error(err.message || err);
  process.exit(1);
}
