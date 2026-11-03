"""从已解压源码安装技能，不联网、不覆盖已有目录。"""
import argparse
from pathlib import Path
import shutil
import sys


def install(source, destination):
    source = source.resolve()
    destination = destination.expanduser().resolve()
    if not (source / "SKILL.md").is_file():
        raise ValueError("来源缺少 SKILL.md")
    if destination == source or source in destination.parents:
        raise ValueError("安装位置不能位于来源目录内")
    if any(path.is_symlink() for path in source.rglob("*")):
        raise ValueError("来源含符号链接，请先核对实际文件")
    if destination.exists():
        raise FileExistsError("已安装同名技能；请先人工备份并处理，工具不会覆盖")
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(source, destination)
    return destination


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path(__file__).resolve().parents[1] / "skills/generated-admin-hardening")
    parser.add_argument("--dest", type=Path, default=Path.home() / ".agents/skills/generated-admin-hardening",
                        help="完整技能目标目录；仓库级可指定 .agents/skills/generated-admin-hardening")
    args = parser.parse_args(argv)
    try:
        destination = install(args.source, args.dest)
    except (OSError, ValueError) as error:
        print(f"安装失败：{error}", file=sys.stderr)
        return 1
    print(f"已安装到 {destination}；可直接读取此目录的 SKILL.md 继续当前任务。客户端自动发现未刷新时，新对话或重启后再原生调用 $generated-admin-hardening。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
