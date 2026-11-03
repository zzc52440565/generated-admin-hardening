"""从单一技能源生成下载包、源码包和便携文本，不发布网络。"""
import argparse
import hashlib
from pathlib import Path
import re
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SKILL = ROOT / "skills/generated-admin-hardening"


def files_under(root):
    for path in sorted(root.rglob("*")):
        if any(part in ("__pycache__", ".git", "dist", ".DS_Store", "private") for part in path.relative_to(root).parts):
            continue
        if path.is_symlink():
            raise ValueError("发布包不接受符号链接")
        if path.is_file() and path.suffix not in (".pyc", ".pyo", ".pem", ".key", ".p12") and not path.name.startswith(".env"):
            yield path


def make_zip(output, files, base, prefix):
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in files:
            info = zipfile.ZipInfo(str(Path(prefix) / path.relative_to(base)), date_time=(2026, 11, 3, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, path.read_bytes())


def build(output, version):
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise ValueError("版本号必须是 x.y.z")
    output = output.resolve()
    if output != (ROOT / "dist").resolve():
        raise ValueError("固定输出到源码根目录 dist，避免将其他目录或输出自身打包")
    output.mkdir(exist_ok=True)
    portable = output / f"generated-admin-hardening-{version}-portable.md"
    chunks = ["# 生成项目加固、SQL 重设计与图表同步：便携参考\n\n"
              "由技能源码生成。请将全文作为本次任务参考附件，并明确请求使用。\n"
              "这不是自动安装包，任意目录中的文件不会因此自动成为系统指令。\n"
              "本文件包含全部格式参考和示例；只有有终端/文件/浏览器能力的工具才能执行相应验证。\n"]
    chunks.append("可选 Python 脚本不嵌入本文件；需要脚本时下载完整技能目录，否则复用目标项目测试并标记未跑项。\n")
    assets = [path for path in sorted((SKILL / "assets").rglob("*"))
              if path.is_file() and path.suffix in (".md", ".txt", ".sql")]
    prompt_files = [SKILL / "PROMPT.md"] if (SKILL / "PROMPT.md").is_file() else []
    for path in [SKILL / "SKILL.md", *prompt_files, *sorted((SKILL / "references").glob("*.md")), *assets]:
        content = path.read_text(encoding="utf-8")
        # 便携版已经合并参考内容，不能保留指向 ZIP 目录的失效相对链接。
        content = re.sub(r"\[([^\]]+)\]\((?!https?://)([^)]+)\)",
                         lambda match: f"{match[1]}（源文件：{match[2]}）", content)
        if path.suffix in (".txt", ".sql"):
            language = "sql" if path.suffix == ".sql" else "text"
            content = f"```{language}\n" + content.rstrip("\n") + "\n```\n"
        chunks.append(f"\n---\n\n## 来源：{path.relative_to(SKILL)}\n\n{content}")
    portable.write_text("\n".join(chunks), encoding="utf-8")
    skill_zip = output / f"generated-admin-hardening-{version}.zip"
    source_zip = output / f"generated-admin-hardening-{version}-source.zip"
    make_zip(skill_zip, files_under(SKILL), SKILL, "generated-admin-hardening")
    source_dirs = {"skills", "tools", "tests", "docs"}
    source_names = {"README.md", ".gitignore", "VERSION", "LICENSE", "LICENSE.md", "NOTICE", "CHANGELOG.md"}
    sources = [path for path in files_under(ROOT)
               if path.relative_to(ROOT).parts[0] in source_dirs or
               (path.parent == ROOT and path.name in source_names)]
    make_zip(source_zip, sources, ROOT, "generated-admin-hardening-release")
    hashes = {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in (skill_zip, source_zip, portable)}
    sums = "".join(f"{digest}  {name}\n" for name, digest in hashes.items())
    (output / f"SHA256SUMS-{version}.txt").write_text(sums, encoding="utf-8")
    (output / "SHA256SUMS.txt").write_text(sums, encoding="utf-8")
    return hashes


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", default=(ROOT / "VERSION").read_text(encoding="utf-8").strip())
    args = parser.parse_args()
    for name in build(ROOT / "dist", args.version):
        print(name)


if __name__ == "__main__":
    main()
