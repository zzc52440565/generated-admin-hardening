#!/usr/bin/env bash
# 捷码项目本机环境诊断（macOS，只读）。
#
# 只做三件事：查本机事实、判定组件状态、给出下一步动作；不安装、不修复、不读取任何真实口令。
#
# 输出：默认 NDJSON，一行一条记录（type=platform / type=component / type=summary），
# 字段与 diagnose-windows.ps1 同构。加 --human 输出人类可读文本。
#
# 用法：
#   bash diagnose-macos.sh --components java,maven,mysql --json
#   bash diagnose-macos.sh --components java,maven,tomcat --project /abs/path --java-major 21
#   bash diagnose-macos.sh --components mysql --mysql-cnf ~/my.cnf --mysql-datadir ~/mysql-data
#
# 退出码：0=全部 ok；1=存在非 ok 组件；2=参数或平台错误。

set -u
LC_ALL=C
export LC_ALL

COMPONENTS=''
PROJECT=''
JSON_MODE='1'
JAVA_MAJOR='0'
NODE_MAJOR='0'
MYSQL_PORT='3306'
PG_PORT='5432'
REDIS_PORT='6379'
TOMCAT_PORT='8080'
MYSQL_CNF=''
MYSQL_DATADIR=''
TIMEOUT='5'

usage() {
  cat <<'EOF'
用法: bash diagnose-macos.sh --components <列表> [选项]

必填:
  --components java,maven,node,npm,mysql,tomcat,...   只诊断当前项目需要的组件

可选:
  --project <绝对路径>      已下载项目目录（用于识别 mvnw/gradlew、外部 WAR 等）
  --java-major <n>         项目要求的 JDK 主版本
  --node-major <n>         项目要求的 Node 主版本
  --mysql-port <port>      默认 3306
  --postgres-port <port>   默认 5432
  --redis-port <port>      默认 6379
  --tomcat-port <port>     默认 8080
  --mysql-cnf <文件>       已知 MySQL 配置文件（可选，仅用于只读检查数据目录）
  --mysql-datadir <目录>   已知 MySQL 数据目录（可选）
  --timeout <秒>           端口探测超时，默认 5
  --human                  输出人类可读文本而不是 NDJSON
  -h, --help               显示本帮助

支持的组件:
  java maven gradle node npm yarn pnpm git python go
  mysql postgresql redis sqlite sqlserver oracle
  tomcat msbuild dotnet wxdevtools
EOF
}

die() { printf '%s\n' "错误: $*" >&2; exit 2; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --components) [ "$#" -ge 2 ] || die '--components 缺少取值'; COMPONENTS="$2"; shift 2 ;;
    --project) [ "$#" -ge 2 ] || die '--project 缺少取值'; PROJECT="$2"; shift 2 ;;
    --java-major) [ "$#" -ge 2 ] || die '--java-major 缺少取值'; JAVA_MAJOR="$2"; shift 2 ;;
    --node-major) [ "$#" -ge 2 ] || die '--node-major 缺少取值'; NODE_MAJOR="$2"; shift 2 ;;
    --mysql-port) [ "$#" -ge 2 ] || die '--mysql-port 缺少取值'; MYSQL_PORT="$2"; shift 2 ;;
    --postgres-port) [ "$#" -ge 2 ] || die '--postgres-port 缺少取值'; PG_PORT="$2"; shift 2 ;;
    --redis-port) [ "$#" -ge 2 ] || die '--redis-port 缺少取值'; REDIS_PORT="$2"; shift 2 ;;
    --tomcat-port) [ "$#" -ge 2 ] || die '--tomcat-port 缺少取值'; TOMCAT_PORT="$2"; shift 2 ;;
    --mysql-cnf) [ "$#" -ge 2 ] || die '--mysql-cnf 缺少取值'; MYSQL_CNF="$2"; shift 2 ;;
    --mysql-datadir) [ "$#" -ge 2 ] || die '--mysql-datadir 缺少取值'; MYSQL_DATADIR="$2"; shift 2 ;;
    --timeout) [ "$#" -ge 2 ] || die '--timeout 缺少取值'; TIMEOUT="$2"; shift 2 ;;
    --json) JSON_MODE='1'; shift ;;
    --human) JSON_MODE='0'; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数: $1" ;;
  esac
done

[ -n "$COMPONENTS" ] || { usage >&2; exit 2; }
[ "$(uname -s 2>/dev/null)" = 'Darwin' ] || die '本脚本只支持 macOS；Windows 请用 diagnose-windows.ps1'

case "$JAVA_MAJOR$NODE_MAJOR$MYSQL_PORT$PG_PORT$REDIS_PORT$TOMCAT_PORT$TIMEOUT" in
  *[!0-9]* ) die '版本号、端口与超时参数必须是整数' ;;
esac

if [ -n "$PROJECT" ]; then
  case "$PROJECT" in
    /*) [ -d "$PROJECT" ] || die "项目目录不存在: $PROJECT" ;;
    *) die '--project 必须是绝对路径' ;;
  esac
fi

# ---------------------------------------------------------------------------
# JSON 基础工具
# ---------------------------------------------------------------------------

json_escape() {
  printf '%s' "${1-}" \
    | tr -d '\000-\010\013\014\016-\037' \
    | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' \
    | awk 'BEGIN{ORS=""} {gsub(/\r/," "); if (NR>1) printf "\\n"; printf "%s", $0}'
}

jstr() { printf '"%s"' "$(json_escape "${1-}")"; }

jstr_or_null() { if [ -n "${1-}" ]; then jstr "$1"; else printf 'null'; fi; }

jnum_or_null() {
  case "${1-}" in
    ''|*[!0-9]*) printf 'null' ;;
    *) printf '%s' "$1" ;;
  esac
}

jbool() {
  case "${1-}" in
    true|yes|1) printf 'true' ;;
    false|no|0) printf 'false' ;;
    *) printf 'null' ;;
  esac
}

jarr() {
  local first='1' item seen=() dup existing
  printf '['
  for item in "$@"; do
    [ -n "$item" ] || continue
    dup='0'
    for existing in "${seen[@]:-}"; do
      [ "$existing" = "$item" ] && { dup='1'; break; }
    done
    [ "$dup" = '1' ] && continue
    seen+=("$item")
    if [ "$first" = '1' ]; then first='0'; else printf ','; fi
    jstr "$item"
  done
  printf ']'
}

# 故障数组：每项形如 "code::detail"
jfaults() {
  local first='1' item code detail
  printf '['
  for item in "$@"; do
    [ -n "$item" ] || continue
    code="${item%%::*}"
    detail="${item#*::}"
    if [ "$first" = '1' ]; then first='0'; else printf ','; fi
    printf '{"code":%s,"detail":%s}' "$(jstr "$code")" "$(jstr "$detail")"
  done
  printf ']'
}

# ---------------------------------------------------------------------------
# 探测结果载体
# ---------------------------------------------------------------------------

RECORDS=()
HUMAN=()

C_STATE='ok'
C_VERSION=''
C_MAJOR=''
C_REQUIRED=''
C_PATH=''
C_EVIDENCE=''
C_NEXT=''
C_FORBIDDEN=''
C_INPS=''
C_PO=''
C_CANDIDATES=()
C_NOTES=()
C_INJ=()
C_FAULTS=()
C_RAW=()

probe_reset() {
  C_STATE='ok'
  C_VERSION=''
  C_MAJOR=''
  C_REQUIRED=''
  C_PATH=''
  C_EVIDENCE=''
  C_NEXT=''
  C_FORBIDDEN=''
  C_INPS=''
  C_PO='false'
  C_CANDIDATES=()
  C_NOTES=()
  C_INJ=()
  C_FAULTS=()
  C_RAW=()
  DISCOVERED_DATADIR=''
  DISCOVERED_SERVER_CMD=''
}

emit_component() {
  local name="$1" rec item
  rec="{\"type\":\"component\",\"component\":$(jstr "$name")"
  rec="$rec,\"state\":$(jstr "$C_STATE")"
  rec="$rec,\"version\":$(jstr_or_null "$C_VERSION")"
  rec="$rec,\"major\":$(jnum_or_null "$C_MAJOR")"
  rec="$rec,\"requiredMajor\":$(jnum_or_null "$C_REQUIRED")"
  rec="$rec,\"resolvedPath\":$(jstr_or_null "$C_PATH")"
  rec="$rec,\"candidates\":$(jarr "${C_CANDIDATES[@]:-}")"
  rec="$rec,\"inPersistentPath\":$(jbool "$C_INPS")"
  rec="$rec,\"processOnlyPath\":$(jbool "$C_PO")"
  rec="$rec,\"injected\":$(jarr "${C_INJ[@]:-}")"
  rec="$rec,\"faults\":$(jfaults "${C_FAULTS[@]:-}")"
  rec="$rec,\"notes\":$(jarr "${C_NOTES[@]:-}")"
  rec="$rec,\"evidence\":$(jstr_or_null "$C_EVIDENCE")"
  rec="$rec,\"nextAction\":$(jstr_or_null "$C_NEXT")"
  rec="$rec,\"forbidden\":$(jstr_or_null "$C_FORBIDDEN")"
  for item in "${C_RAW[@]:-}"; do
    [ -n "$item" ] && rec="$rec,$item"
  done
  rec="$rec}"
  RECORDS+=("$rec")
  local human_line
  human_line="$(printf '[%-22s] %-12s' "$C_STATE" "$name")"
  if [ -n "$C_VERSION" ]; then human_line="$human_line $C_VERSION"; fi
  if [ -n "$C_PATH" ]; then human_line="$human_line @ $C_PATH"; fi
  if [ -n "$C_NEXT" ]; then human_line="$human_line -> $C_NEXT"; fi
  HUMAN+=("$human_line")
  [ "$C_STATE" = 'ok' ] || BAD_STATES=$((BAD_STATES + 1))
}

# ---------------------------------------------------------------------------
# 平台事实与 PATH 来源判定
# ---------------------------------------------------------------------------

OS_VERSION="$(sw_vers -productVersion 2>/dev/null || printf 'unknown')"
OS_BUILD="$(sw_vers -buildVersion 2>/dev/null || printf 'unknown')"
ARCH="$(uname -m 2>/dev/null || printf 'unknown')"
NSW_VERS="$(sysctl -n kern.osproductversion 2>/dev/null || printf '')"

PERSISTENT_PATHS=()
PERSISTENT_SOURCES=()
INJECT_MARKERS='WorkBuddy|Visual Studio Code|Windsurf|Electron|\.app/Contents|node_modules/\.bin|/(dsh|codex)(/|$)|app\.asar|antigravity|\.cursor|codebuddy|trae|kimi-code'

normalize_dir() {
  local dir="$1"
  case "$dir" in
    '') return 0 ;;
    '~') dir="$HOME" ;;
    '~/'*) dir="$HOME/${dir#\~/}" ;;
  esac
  case "$dir" in /*) ;; *) return 0 ;; esac
  # 去掉尾部斜杠（保留根）
  while [ "${dir%/}" != "$dir" ] && [ "$dir" != '/' ]; do dir="${dir%/}"; done
  printf '%s' "$dir"
}

add_persistent() {
  local dir
  dir="$(normalize_dir "${1-}")"
  [ -n "$dir" ] || return 0
  [ -d "$dir" ] || return 0
  local existing
  for existing in "${PERSISTENT_PATHS[@]:-}"; do
    [ "$existing" = "$dir" ] && return 0
  done
  PERSISTENT_PATHS+=("$dir")
}

# /etc/paths 与 /etc/paths.d/* 是 macOS 登录终端的 PATH 基线
collect_paths_file() {
  local file="$1" line
  [ -f "$file" ] || return 0
  while IFS= read -r line; do
    case "$line" in ''|'#'*) continue ;; esac
    add_persistent "$line"
  done < "$file"
}

collect_rc_dirs() {
  local file="$1" line token
  [ -f "$file" ] || return 0
  PERSISTENT_SOURCES+=("$file")
  while IFS= read -r line; do
    case "$line" in
      ''|'#'*) continue ;;
    esac
    case "$line" in
      *PATH*|*path*) ;;
      *) continue ;;
    esac
    # 去掉命令替换（brew --prefix 之类），避免把命令当目录
    line="$(printf '%s' "$line" | sed -E 's/\$\([^)]*\)//g; s/`[^`]*`//g')"
    line="${line//\$\{HOME\}/$HOME}"
    line="${line//\$HOME/$HOME}"
    line="${line//\~\//$HOME/}"
    for token in $(printf '%s' "$line" | tr ':=()[]"' '        '); do
      case "$token" in
        /usr/bin|/bin|/usr/sbin|/sbin|'') continue ;;
        /*) add_persistent "$token" ;;
      esac
    done
  done < "$file"
}

collect_paths_file /etc/paths
for file in /etc/paths.d/*; do
  [ -f "$file" ] && collect_paths_file "$file"
done
for file in /etc/profile "$HOME/.zshenv" "$HOME/.zprofile" "$HOME/.zshrc" "$HOME/.bash_profile" "$HOME/.profile"; do
  collect_rc_dirs "$file"
done
add_persistent /usr/bin
add_persistent /bin
add_persistent /usr/sbin
add_persistent /sbin

# 进程 PATH：只用于对比，不作为用户环境结论
PROCESS_PATHS=()
PROCESS_ONLY=()
INJECTED=()
IFS=':' read -r -a _raw_paths <<< "${PATH-}"
for dir in "${_raw_paths[@]}"; do
  dir="$(normalize_dir "$dir")"
  [ -n "$dir" ] || continue
  PROCESS_PATHS+=("$dir")
  in_persistent='0'
  for p in "${PERSISTENT_PATHS[@]:-}"; do
    [ "$p" = "$dir" ] && in_persistent='1' && break
  done
  if [ "$in_persistent" = '0' ]; then
    PROCESS_ONLY+=("$dir")
    if printf '%s' "$dir" | grep -Eqi "$INJECT_MARKERS"; then
      INJECTED+=("$dir")
    fi
  fi
done

is_in_persistent() {
  local dir="$1" p
  dir="$(normalize_dir "$dir")"
  for p in "${PERSISTENT_PATHS[@]:-}"; do
    [ "$p" = "$dir" ] && return 0
  done
  return 1
}

# 命令解析到的目录是否只存在于宿主注入路径
resolve_class() {
  local resolved="$1" dir
  dir="$(dirname "$resolved")"
  if is_in_persistent "$dir"; then
    printf 'persistent'
    return 0
  fi
  local injected
  for injected in "${INJECTED[@]:-}"; do
    [ "$injected" = "$dir" ] && { printf 'injected'; return 0; }
  done
  printf 'process-only'
}

port_open() {
  local port="$1"
  if command -v nc >/dev/null 2>&1; then
    nc -z -G 2 -w 2 127.0.0.1 "$port" >/dev/null 2>&1 && return 0
    return 1
  fi
  ( exec 3<>"/dev/tcp/127.0.0.1/$port" ) >/dev/null 2>&1 && return 0
  return 1
}

first_line() { printf '%s' "${1-}" | awk 'NR==1{print; exit}'; }

uniq_count() {
  local seen=() item existing dup n=0
  for item in "$@"; do
    [ -n "$item" ] || continue
    dup='0'
    for existing in "${seen[@]:-}"; do
      [ "$existing" = "$item" ] && { dup='1'; break; }
    done
    [ "$dup" = '1' ] && continue
    seen+=("$item")
    n=$((n + 1))
  done
  printf '%s' "$n"
}

version_major() {
  local raw first second
  raw="$(printf '%s' "${1-}" | tr -d '\r')"
  first="$(printf '%s' "$raw" | sed -nE 's/^[^0-9]*([0-9]+).*/\1/p')"
  [ -n "$first" ] || { printf ''; return 0; }
  if [ "$first" = '1' ]; then
    second="$(printf '%s' "$raw" | sed -nE 's/^[^0-9]*1\.([0-9]+).*/\1/p')"
    [ -n "$second" ] && { printf '%s' "$second"; return 0; }
  fi
  printf '%s' "$first"
}

# ---------------------------------------------------------------------------
# 各组件探测
# ---------------------------------------------------------------------------

probe_generic_version_cmd() {
  # $1 组件名 $2 命令 $3 版本参数 $4 要求主版本
  local name="$1" cmd="$2" varg="$3" required="$4" resolved output major cls
  C_REQUIRED="$required"
  resolved="$(command -v "$cmd" 2>/dev/null || printf '')"
  if [ -z "$resolved" ]; then
    C_STATE='missing'
    C_NEXT="确认本项目确实需要 $name；需要时按 references/install-recipes.md 装到独立前缀"
    C_FORBIDDEN='不要因为缺一个工具就批量安装其它组件'
    return 0
  fi
  C_PATH="$resolved"
  output="$("$resolved" "$varg" 2>&1)"; local rc=$?
  C_EVIDENCE="$(first_line "$output")"
  if [ $rc -ne 0 ]; then
    C_STATE='data-corrupt'
    C_NOTES+=("$cmd 存在但执行失败（退出码 $rc）")
    C_NEXT='保留原始报错，确认安装目录是否损坏；损坏时重新解压到独立前缀'
    C_FORBIDDEN='不要覆盖安装到已有目录'
    return 0
  fi
  C_VERSION="$(first_line "$output")"
  major="$(version_major "$C_VERSION")"
  C_MAJOR="$major"
  cls="$(resolve_class "$resolved")"
  if [ "$cls" = 'persistent' ]; then C_INPS='true'; else C_INPS='false'; C_PO='true'; fi
  if [ "$cls" = 'injected' ]; then
    C_INJ+=("$resolved")
    C_STATE='path-invisible'
    C_NOTES+=("只在 WorkBuddy/IDE 注入的 PATH 中可见；用户新开终端的持久化 PATH 里没有它")
    C_NEXT='用新终端（或按持久化 PATH 重建的环境）复查，再决定是否安装'
    C_FORBIDDEN='不要把宿主注入的运行时当成用户已安装'
    return 0
  fi
  if [ "$required" != '0' ] && [ -n "$major" ] && [ "$major" -lt "$required" ]; then
    C_STATE='version-incompatible'
    C_NEXT="需要主版本 ≥ $required；优先并行安装新版本到独立前缀并调整本项目 PATH，不卸载旧版本"
    C_FORBIDDEN='不要卸载旧版本（老项目可能依赖它），不要全局覆盖默认版本'
    return 0
  fi
  C_STATE='ok'
  C_NEXT='命令可用不等于项目可用；仍需实际构建或运行验证'
}

probe_java() {
  local resolved output major home_list d candidate_major cls javac
  C_REQUIRED="${JAVA_MAJOR}"
  resolved="$(command -v java 2>/dev/null || printf '')"

  # 枚举已知 JDK 位置（多版本共存是合法布局，不算冲突）
  for d in /Library/Java/JavaVirtualMachines/*/Contents/Home "$HOME"/Library/Java/JavaVirtualMachines/*/Contents/Home \
      /opt/homebrew/opt/openjdk* /usr/local/opt/openjdk* "$HOME"/.local/jiema-env/*; do
    if [ -x "$d/bin/java" ]; then
      C_CANDIDATES+=("$d")
    elif [ -x "$d/Contents/Home/bin/java" ]; then
      C_CANDIDATES+=("$d/Contents/Home")
    fi
  done
  if [ -x /usr/libexec/java_home ]; then
    d="$(/usr/libexec/java_home 2>/dev/null || printf '')"
    [ -n "$d" ] && [ -x "$d/bin/java" ] && C_CANDIDATES+=("$d")
  fi

  if [ -n "${JAVA_HOME-}" ] && [ ! -d "${JAVA_HOME}" ]; then
    C_FAULTS+=("java-home-dangling::JAVA_HOME 指向不存在的目录，Maven/Gradle/Tomcat 会因此失败")
  fi

  if [ -z "$resolved" ]; then
    if [ "$(uniq_count "${C_CANDIDATES[@]:-}")" -gt 0 ]; then
      C_STATE='path-invisible'
      C_NOTES+=("本机已存在 JDK 目录，但 java 不在 PATH: ${C_CANDIDATES[0]}")
      C_NEXT='把该 JDK 的 bin 目录加入本项目/用户 PATH，或设置 JAVA_HOME；不要重装'
      C_FORBIDDEN='不要因为 PATH 看不到就重装 JDK'
      return 0
    fi
    C_STATE='missing'
    C_NEXT="安装 JDK ${JAVA_MAJOR:-17}（Temurin 官方包或 Homebrew）到独立前缀"
    C_FORBIDDEN='不要用 curl | bash 安装包管理器'
    return 0
  fi

  C_PATH="$resolved"
  output="$("$resolved" -version 2>&1)"
  C_EVIDENCE="$(first_line "$output")"
  major="$(version_major "$(first_line "$output")")"
  C_MAJOR="$major"
  C_VERSION="$(printf '%s' "$(first_line "$output")" | sed -nE 's/.*version "?([^"]*)"?.*/\1/p')"
  [ -n "$C_VERSION" ] || C_VERSION="$(first_line "$output")"

  # /usr/bin/java 是 macOS 转发壳，不是第二份 JDK
  if [ "$resolved" = '/usr/bin/java' ] && [ -x /usr/libexec/java_home ]; then
    home_list="$(/usr/libexec/java_home 2>/dev/null || printf '')"
    [ -n "$home_list" ] && C_NOTES+=("java 解析到系统转发壳 /usr/bin/java，真实 JDK: $home_list")
  fi

  cls="$(resolve_class "$resolved")"
  if [ "$cls" = 'persistent' ]; then C_INPS='true'; else C_INPS='false'; C_PO='true'; fi

  # 解析到的 java 旁边没有 javac：多半是包装脚本或占位壳，不是 JDK 本体
  javac="$(dirname "$resolved")/javac"
  if [ ! -x "$javac" ]; then
    C_FAULTS+=("java-resolved-without-javac::解析到的 java（$resolved）同目录没有 javac，疑似包装脚本或占位壳")
    C_NOTES+=('能打印版本不等于能编译；构建会失败')
  fi

  if [ "$cls" = 'injected' ]; then
    C_INJ+=("$resolved")
    C_STATE='path-invisible'
    C_NEXT='这是宿主注入的运行时，用户新终端看不到；按真实安装位置决定修复方式'
    C_FORBIDDEN='不要把宿主自带 JDK 当成用户环境'
    return 0
  fi

  if [ -z "$major" ]; then
    C_STATE='version-incompatible'
    C_NOTES+=('无法解析 JDK 版本')
    C_NEXT='手工确认 java -version 输出与实际 JDK 目录'
    return 0
  fi

  if [ "$JAVA_MAJOR" != '0' ] && [ "$major" -lt "$JAVA_MAJOR" ]; then
    C_STATE='version-incompatible'
    if [ "$(uniq_count "${C_CANDIDATES[@]:-}")" -gt 1 ]; then
      C_NOTES+=("本机还有其他 JDK（共 $(uniq_count "${C_CANDIDATES[@]:-}") 个候选）；多版本共存不是故障，问题只是生效版本太低")
      C_NEXT="把满足 ≥$JAVA_MAJOR 的 JDK 提到本项目 PATH 最前，或为项目设置 JAVA_HOME；其余版本保留"
    else
      C_NEXT="安装 JDK $JAVA_MAJOR 到独立前缀，用项目级 PATH/JAVA_HOME 指向它"
    fi
    C_FORBIDDEN='不要卸载或覆盖机器上已有的 JDK'
    return 0
  fi

  C_STATE='ok'
  if [ "$(uniq_count "${C_CANDIDATES[@]:-}")" -gt 1 ]; then
    C_NOTES+=("本机共存 $(uniq_count "${C_CANDIDATES[@]:-}") 个 JDK 目录；生效版本满足要求，属合法多版本布局")
  fi
  C_NEXT='java -version 通过仍不够；需要用项目源码真实编译一次'
}

probe_maven() {
  local resolved output rc wrapper='' fake
  C_REQUIRED='0'
  if [ -n "$PROJECT" ] && [ -f "$PROJECT/mvnw" ]; then wrapper="$PROJECT/mvnw"; fi
  resolved="$(command -v mvn 2>/dev/null || printf '')"

  if [ -z "$resolved" ]; then
    for fake in "$HOME"/.local/jiema-env/*/bin/mvn /opt/homebrew/opt/maven*/bin/mvn /usr/local/opt/maven*/bin/mvn /usr/local/bin/mvn; do
      [ -x "$fake" ] && { C_CANDIDATES+=("$fake"); }
    done
    if [ -n "$wrapper" ]; then
      C_STATE='ok'
      C_NOTES+=("项目自带 mvnw，可优先用包装器构建；构建时才能验证包装器下载与 JDK 匹配")
      C_PATH="$wrapper"
      C_NEXT='用 ./mvnw -B validate 试构建；包装器下载失败时再考虑独立前缀安装 Maven'
      return 0
    fi
    if [ "${#C_CANDIDATES[@]}" -gt 0 ]; then
      C_STATE='path-invisible'
      C_PATH="${C_CANDIDATES[0]}"
      C_NOTES+=('已存在 Maven 安装但不在 PATH')
      C_NEXT='把该 Maven 的 bin 加入 PATH（可用项目级脚本而非全局改动）'
      return 0
    fi
    C_STATE='missing'
    C_NEXT='把官方 Maven 二进制解压到独立前缀（并校验官方 SHA512），或使用项目 mvnw'
    C_FORBIDDEN='不要用 curl | bash 安装；不要跳过摘要校验'
    return 0
  fi

  C_PATH="$resolved"
  output="$("$resolved" -version 2>&1)"; rc=$?
  C_EVIDENCE="$(first_line "$output")"
  if [ $rc -ne 0 ]; then
    if printf '%s' "$output" | grep -Eqi 'java_home|JAVA_HOME|no jdk|JVM'; then
      C_STATE='needs-user-input'
      C_NOTES+=("mvn 启动失败，报错指向 JAVA_HOME/JDK：$(first_line "$output")")
      C_FAULTS+=("maven-java-home-invalid::$(first_line "$output")")
      C_NEXT='先修 JAVA_HOME（指向存在的 JDK），再复验 mvn -v；是否修改用户 profile 需要用户确认'
      C_FORBIDDEN='不要在 JAVA_HOME 无效时继续构建或覆盖安装 Maven'
      return 0
    fi
    C_STATE='data-corrupt'
    C_NOTES+=("mvn 存在但执行失败：$(first_line "$output")")
    C_NEXT='检查 Maven 安装目录完整性与权限；必要时重新解压到新前缀'
    return 0
  fi
  C_VERSION="$(first_line "$output")"
  C_MAJOR=''
  local mvn_cls
  mvn_cls="$(resolve_class "$resolved")"
  if [ "$mvn_cls" = 'persistent' ]; then C_INPS='true'; else C_INPS='false'; C_PO='true'; fi
  if [ "$mvn_cls" = 'injected' ]; then
    C_INJ+=("$resolved")
    C_STATE='path-invisible'
    C_NEXT='宿主注入的 mvn 不算用户环境；改为独立前缀安装或项目包装器'
    return 0
  fi
  C_STATE='ok'
  C_NEXT='mvn -version 通过仍不够；要能用项目 pom 真实构建'
  [ -n "$wrapper" ] && C_NOTES+=('项目同时带 mvnw；优先用包装器，减少对全局 Maven 版本的依赖')
}

probe_node() {
  local resolved output major cls
  C_REQUIRED="${NODE_MAJOR}"
  resolved="$(command -v node 2>/dev/null || printf '')"
  if [ -z "$resolved" ]; then
    C_STATE='missing'
    C_NEXT="安装 Node ${NODE_MAJOR:-18}（官方包或版本管理器）到独立前缀"
    return 0
  fi
  C_PATH="$resolved"
  output="$("$resolved" --version 2>&1)"
  C_EVIDENCE="$(first_line "$output")"
  C_VERSION="$(first_line "$output")"
  major="$(version_major "$C_VERSION")"
  C_MAJOR="$major"
  cls="$(resolve_class "$resolved")"
  if [ "$cls" = 'persistent' ]; then C_INPS='true'; else C_INPS='false'; C_PO='true'; fi
  if [ "$cls" = 'injected' ]; then
    C_INJ+=("$resolved")
    C_STATE='path-invisible'
    C_NOTES+=('node 只来自 WorkBuddy/IDE 注入的 PATH；用户新终端（持久化 PATH）看不到它')
    C_NEXT='用新终端复查；确实缺失时把 Node 装到独立前缀，不要动宿主的运行时'
    C_FORBIDDEN='不要卸载或覆盖宿主自带的 Node'
    return 0
  fi
  if [ "$NODE_MAJOR" != '0' ] && [ -n "$major" ] && [ "$major" -lt "$NODE_MAJOR" ]; then
    C_STATE='version-incompatible'
    C_NEXT="项目要求 Node ≥ $NODE_MAJOR；并行安装新版本到独立前缀并切换本项目 PATH"
    C_FORBIDDEN='不要直接全局升级覆盖正在使用的 Node'
    return 0
  fi
  C_STATE='ok'
  C_NEXT='node -v 通过仍不够；需要真实 npm install / build'
}

probe_npm() {
  local resolved output
  C_REQUIRED='0'
  resolved="$(command -v npm 2>/dev/null || printf '')"
  if [ -z "$resolved" ]; then
    C_STATE='missing'
    C_NEXT='npm 通常随 Node 一起安装；先确认 Node 装在哪'
    return 0
  fi
  C_PATH="$resolved"
  output="$("$resolved" --version 2>&1)"
  C_EVIDENCE="$(first_line "$output")"
  C_VERSION="$(first_line "$output")"
  if [ "$(resolve_class "$resolved")" = 'persistent' ]; then C_INPS='true'; else C_INPS='false'; C_PO='true'; fi
  C_STATE='ok'
  C_NEXT='npm 版本通过仍不够；要能装依赖并构建'
}

# 运行中实例发现（只读：看进程与监听，不启动、不停止、不写配置）
port_pids() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -5
}

proc_command() {
  ps -o command= -p "$1" 2>/dev/null | head -1
}

find_listening_server() {
  # $1 端口 $2 服务端二进制名；输出 "<可执行文件绝对路径>|<完整命令行>"，找不到时输出空
  local port="$1" bin="$2" pid cmd exe
  for pid in $(port_pids "$port"); do
    cmd="$(proc_command "$pid")"
    case "$cmd" in
      *"$bin"*) ;;
      *) continue ;;
    esac
    exe="$(printf '%s' "$cmd" | awk '{print $1}')"
    case "$exe" in
      /*) printf '%s|%s' "$exe" "$cmd"; return 0 ;;
    esac
  done
  return 0
}

probe_database() {
  # $1 组件名 $2 客户端命令 $3 端口 $4 服务端二进制名 $5 包名前缀 $6 探测方式(mysql|postgres|redis)
  local name="$1" client="$2" port="$3" server_bin="$4" label="$5" flavor="${6:-mysql}"
  local resolved_client='' server_exe='' server_path='' candidate basedir='' cls
  C_REQUIRED='0'
  C_RAW+=("\"port\":$port")

  # 1) 先看本机是否已有正在运行的实例（已有实例优先复用，绝不另装一套抢端口）
  local server_info='' server_running='false'
  server_info="$(find_listening_server "$port" "$server_bin")"
  if [ -n "$server_info" ]; then
    server_exe="${server_info%%|*}"
    DISCOVERED_SERVER_CMD="${server_info#*|}"
    server_running='true'
    C_CANDIDATES+=("server:$server_exe")
    basedir="$(printf '%s' "$DISCOVERED_SERVER_CMD" | sed -nE 's/.*--basedir=([^ ]+).*/\1/p')"
    DISCOVERED_DATADIR="$(printf '%s' "$DISCOVERED_SERVER_CMD" | sed -nE 's/.*--datadir=([^ ]+).*/\1/p')"
    if [ -z "$DISCOVERED_DATADIR" ] && [ "$flavor" = 'postgres' ]; then
      DISCOVERED_DATADIR="$(printf '%s' "$DISCOVERED_SERVER_CMD" | sed -nE 's/.*-D ?([^ ]+).*/\1/p')"
    fi
  fi

  # 2) 未运行但存在服务端二进制：说明装了但没起
  if [ -z "$server_exe" ]; then
    for server_path in "$(command -v "$server_bin" 2>/dev/null || printf '')" \
        "$HOME"/.local/jiema-env/*/bin/"$server_bin" \
        /opt/homebrew/opt/"$label"*/bin/"$server_bin" /usr/local/opt/"$label"*/bin/"$server_bin" \
        /usr/local/"$label"/bin/"$server_bin" /usr/local/mysql/bin/"$server_bin" \
        /Library/PostgreSQL/*/bin/"$server_bin"; do
      [ -n "$server_path" ] && [ -x "$server_path" ] && { server_exe="$server_path"; break; }
    done
    [ -n "$server_exe" ] && C_CANDIDATES+=("server:$server_exe")
  fi

  # 3) 客户端：先 PATH，再看运行中实例的 basedir/bin 与已知安装目录（不是第二份安装）
  resolved_client="$(command -v "$client" 2>/dev/null || printf '')"
  local client_in_path='false'
  if [ -n "$resolved_client" ]; then client_in_path='true'; fi
  if [ -z "$resolved_client" ]; then
    local -a client_candidates=()
    if [ -n "$basedir" ]; then client_candidates+=("$basedir/bin/$client"); fi
    if [ -n "$server_exe" ]; then client_candidates+=("$(dirname "$(dirname "$server_exe")")/bin/$client"); fi
    client_candidates+=("$HOME"/.local/jiema-env/*/bin/"$client" \
      /opt/homebrew/opt/"$label"*/bin/"$client" /usr/local/opt/"$label"*/bin/"$client" \
      /usr/local/"$label"/bin/"$client" /usr/local/mysql/bin/"$client" \
      /Library/PostgreSQL/*/bin/"$client" /Applications/Postgres.app/Contents/Versions/*/bin/"$client")
    for candidate in "${client_candidates[@]:-}"; do
      [ -n "$candidate" ] && [ -x "$candidate" ] && { resolved_client="$candidate"; break; }
    done
  fi

  if [ -n "$resolved_client" ]; then
    C_PATH="$resolved_client"
    C_CANDIDATES+=("client:$resolved_client")
    C_VERSION="$(first_line "$("$resolved_client" --version 2>&1)")"
    C_EVIDENCE="$C_VERSION"
    cls="$(resolve_class "$resolved_client")"
    if [ "$cls" = 'persistent' ]; then C_INPS='true'; else C_INPS='false'; C_PO='true'; fi
    [ "$cls" = 'injected' ] && C_INJ+=("$resolved_client")
  fi

  C_RAW+=("\"serverRunning\":$server_running")
  C_RAW+=("\"clientInPath\":$client_in_path")
  if [ -n "${DISCOVERED_DATADIR-}" ]; then C_RAW+=("\"datadir\":$(jstr "$DISCOVERED_DATADIR")"); fi

  if [ "$server_running" = 'true' ]; then
    C_STATE='ok'
    C_NOTES+=("已有实例在 127.0.0.1:$port 运行（$server_exe）；按“复用已有实例”处理，不再另装一套")
    if [ -n "${DISCOVERED_DATADIR-}" ]; then C_NOTES+=("该实例数据目录: $DISCOVERED_DATADIR"); fi
    if [ "$client_in_path" = 'false' ] && [ -n "$resolved_client" ]; then
      C_NOTES+=("客户端不在 PATH，但在 $resolved_client；用绝对路径或把该 bin 加入 PATH 即可，无需重装")
    elif [ -z "$resolved_client" ]; then
      C_NOTES+=("服务在运行但本机找不到 $client 客户端；只影响命令行排查，不影响 JDBC 连接")
    fi
    C_NEXT='用应用账号真实连接一次目标库（口令走安全输入，不进命令行、不进日志）'
    C_FORBIDDEN='禁止修改已有实例的管理员口令、禁止重建已有数据目录'
    return 0
  fi

  # 端口有人监听但进程名没匹配上：可能是代理/转发/别的进程，也可能是服务端换了可执行名
  if port_open "$port"; then
    if [ -n "$resolved_client" ]; then
      local live_out=''
      case "$flavor" in
        mysql) if command -v mysqladmin >/dev/null 2>&1; then live_out="$(mysqladmin ping --connect-timeout=3 --protocol=TCP -h 127.0.0.1 -P "$port" 2>&1)"; fi ;;
        postgres) if command -v pg_isready >/dev/null 2>&1; then live_out="$(pg_isready -h 127.0.0.1 -p "$port" 2>&1)"; fi ;;
        redis) live_out="$("$resolved_client" -h 127.0.0.1 -p "$port" ping 2>&1)" ;;
      esac
      C_RAW+=("\"probe\":$(jstr "$(first_line "$live_out")")")
      if [ -z "$live_out" ] || printf '%s' "$live_out" | grep -Eqi 'alive|accepting|^PONG|ready|denied|password'; then
        C_STATE='ok'
        C_NOTES+=("127.0.0.1:$port 有服务在响应，但进程名没匹配到 $server_bin；按可达处理，仍需真实鉴权")
        C_NEXT='用应用账号真实连接一次；确认占用该端口的确实是要用的数据库'
        return 0
      fi
      C_STATE='connect-failed'
      C_NOTES+=("端口在监听但客户端连不上：$(first_line "$live_out")")
      C_NEXT='查监听地址/协议（socket vs TCP）、防火墙与端口占用进程；确认是不是目标数据库'
      C_FORBIDDEN='不要用改密或重建数据目录来试着解决连接问题'
      return 0
    fi
    C_STATE='needs-user-input'
    C_NOTES+=("127.0.0.1:$port 有进程在监听，但既没有 $client 客户端，也没有匹配到 $server_bin；无法确认它是什么")
    C_NEXT='请用户确认占用该端口的进程（lsof -nP -iTCP:'$port' -sTCP:LISTEN），再决定复用还是换端口'
    return 0
  fi

  if [ -n "$server_exe" ]; then
    C_STATE='service-stopped'
    C_NOTES+=("本机有服务端二进制（$server_exe）但 127.0.0.1:$port 未监听")
    C_NEXT='先看服务状态与错误日志再启动；启动方式需在计划中单独授权'
    C_FORBIDDEN='不要直接重建数据目录、不要改管理员口令来“试试看”'
    return 0
  fi

  if [ -n "$resolved_client" ]; then
    C_STATE='service-stopped'
    C_NOTES+=("只有客户端，本机 $port 未监听；也可能项目连的是远程实例")
    C_NEXT='先确认连接串指向本机还是远程；需要本机实例时按 provision-mysql-dev 建独立开发实例'
    C_FORBIDDEN='不要复用未知账号或猜测已有实例口令'
    return 0
  fi

  C_STATE='missing'
  C_NEXT='确认组件确实需要：需要本机开发库时装客户端+独立开发实例；连远程库时只需客户端'
  C_FORBIDDEN='不要在已有实例占用端口时再装第二套'
  return 0

}

probe_mysql_extra() {
  # 数据目录只读体检：不启动、不写入、不改配置
  local cnf="${MYSQL_CNF}" datadir="${MYSQL_DATADIR}" default_datadir='' line owner=''
  if [ -z "$datadir" ] && [ -n "${DISCOVERED_DATADIR-}" ]; then datadir="$DISCOVERED_DATADIR"; fi
  if [ -z "$cnf" ]; then
    for candidate in /etc/my.cnf /etc/mysql/my.cnf "$HOME/.my.cnf" /opt/homebrew/etc/my.cnf /usr/local/etc/my.cnf; do
      [ -f "$candidate" ] && { cnf="$candidate"; break; }
    done
  fi
  [ -n "$cnf" ] && C_NOTES+=("配置文件: $cnf")
  if [ -n "$cnf" ] && [ -r "$cnf" ]; then
    while IFS= read -r line; do
      case "$line" in
        datadir*|'datadir '*) default_datadir="$(printf '%s' "$line" | sed -E 's/.*=\s*//')" ;;
      esac
    done < "$cnf"
  fi
  [ -n "$datadir" ] || datadir="$default_datadir"
  [ -n "$datadir" ] || return 0
  if [ ! -e "$datadir" ]; then
    C_FAULTS+=("mysql-datadir-missing::配置指向的数据目录不存在: $datadir")
    C_NOTES+=('数据目录不存在：不要用 --initialize 覆盖猜测路径，先确认实例是否曾经存在')
    return 0
  fi
  if [ ! -r "$datadir" ] || [ ! -x "$datadir" ]; then
    C_FAULTS+=("mysql-datadir-unreadable::数据目录不可读/不可进入（疑似权限损坏）: $datadir")
    if [ ! -w "$datadir" ]; then
      owner="$(stat -f '%Su' "$datadir" 2>/dev/null || printf '')"
      if [ -n "$owner" ] && [ "$owner" != "$(id -un)" ]; then
        C_STATE='needs-elevation'
        C_NOTES+=("数据目录属于 $owner，当前用户（$(id -un)）既不可读也不可写；修权限/改归属需要管理员权限")
        C_NEXT='先备份，再由该目录所有者或管理员修权限；改归属属于系统级操作，交用户执行'
      else
        C_STATE='data-corrupt'
        C_NOTES+=("数据目录当前用户自己拥有，但权限位不可读/不可写（疑似权限被改坏）：$datadir")
        C_NEXT='先备份，再按原属主恢复权限位（chmod 750 + 必要时 chown）后重新诊断'
      fi
      C_FORBIDDEN='禁止 rm -rf 数据目录、禁止 sudo chown 后直接覆盖、禁止重新 --initialize'
      return 0
    fi
    C_STATE='data-corrupt'
    C_NOTES+=('权限损坏先用 chown/chmod 还原归属；不要删除或重建数据目录')
    C_NEXT='确认该目录应由哪个账户拥有，再按用户决定修权限；改动前先备份'
    C_FORBIDDEN='禁止 rm -rf 数据目录或重新 --initialize 覆盖'
    return 0
  fi
  if [ ! -d "$datadir/mysql" ]; then
    C_STATE='data-corrupt'
    C_FAULTS+=("mysql-datadir-incomplete::数据目录缺少系统库 mysql/（疑似未初始化或被破坏）: $datadir")
    C_NEXT='确认是否为空目录或中断的初始化；不要直接覆盖已有数据'
    C_FORBIDDEN='禁止在可疑目录上重新初始化'
    return 0
  fi
  C_NOTES+=("数据目录可读: $datadir")
}

probe_tomcat() {
  local home="${CATALINA_HOME-}" port="$TOMCAT_PORT"
  C_REQUIRED='0'
  if [ -n "$home" ] && [ -x "$home/bin/catalina.sh" ]; then
    C_PATH="$home/bin/catalina.sh"
    if [ ! -w "$home" ] || [ ! -w "$home/logs" ] 2>/dev/null; then
      C_STATE='needs-elevation'
      C_NOTES+=("CATALINA_HOME 存在但当前用户对 $home 或 logs 没有写权限；Tomcat 写入日志与 webapps 需要写权限")
      C_NEXT='优先改用独立前缀的解压版 Tomcat；若必须用系统安装的那份，授权管理员改权限需由用户亲自操作'
      return 0
    fi
    if port_open "$port"; then
      C_STATE='ok'
      C_NOTES+=("CATALINA_HOME 可用且 $port 在监听；仍需部署真实 WAR 后 HTTP 200 才算通过")
      C_NEXT='部署项目 WAR 后请求真实 URL 校验状态码与页面内容'
    else
      C_STATE='service-stopped'
      C_NOTES+=("CATALINA_HOME 存在但 $port 未监听")
      C_NEXT='按需启动（前台或独立前缀脚本），启动动作需在计划中单独授权'
    fi
    return 0
  fi
  local candidate found=''
  for candidate in "$HOME"/.local/jiema-env/*/bin/catalina.sh /opt/homebrew/opt/tomcat*/bin/catalina.sh /usr/local/opt/tomcat*/bin/catalina.sh; do
    [ -x "$candidate" ] && { found="$candidate"; break; }
  done
  if [ -n "$found" ]; then
    C_STATE='path-invisible'
    C_PATH="$found"
    C_CANDIDATES+=("$found")
    C_NOTES+=('发现解压版 Tomcat，但 CATALINA_HOME 未设置')
    C_NEXT='构建/启动时临时设置 CATALINA_HOME，不必改全局环境'
    return 0
  fi
  C_STATE='missing'
  C_NEXT='仅当项目是外部 WAR 部署时才需要 Tomcat；可执行 JAR 不需要'
  C_FORBIDDEN='不要为不需要的项目装 Tomcat'
}

probe_python() {
  local resolved output
  C_REQUIRED='0'
  resolved="$(command -v python3 2>/dev/null || printf '')"
  if [ -z "$resolved" ]; then
    C_STATE='missing'
    C_NEXT='仅当项目确有 Python 依赖时才安装'
    return 0
  fi
  C_PATH="$resolved"
  output="$("$resolved" --version 2>&1)"
  C_EVIDENCE="$(first_line "$output")"
  C_VERSION="$(first_line "$output")"
  if [ "$(resolve_class "$resolved")" = 'persistent' ]; then C_INPS='true'; else C_INPS='false'; C_PO='true'; fi
  C_STATE='ok'
  C_NEXT='python3 --version 通过仍不够；需要能装依赖并跑通项目脚本'
}

probe_git() {
  local resolved
  C_REQUIRED='0'
  resolved="$(command -v git 2>/dev/null || printf '')"
  if [ -z "$resolved" ]; then
    C_STATE='missing'
    C_NEXT='需要版本管理或拉取依赖时才安装 Git'
    return 0
  fi
  C_PATH="$resolved"
  C_VERSION="$(first_line "$(git --version 2>&1)")"
  C_EVIDENCE="$C_VERSION"
  if [ "$(resolve_class "$resolved")" = 'persistent' ]; then C_INPS='true'; else C_INPS='false'; C_PO='true'; fi
  C_STATE='ok'
  C_NEXT='git --version 通过即可，仍应验证能真实 clone 或提交'
}

# ---------------------------------------------------------------------------
# 记录与汇总
# ---------------------------------------------------------------------------

BAD_STATES=0
SUPPORTED='java maven gradle node npm yarn pnpm git python go mysql postgresql redis sqlite sqlserver oracle tomcat msbuild dotnet wxdevtools'

for raw in $(printf '%s' "$COMPONENTS" | tr ',' ' '); do
  item="$(printf '%s' "$raw" | tr -d '[:space:]')"
  [ -n "$item" ] || continue
  case " $SUPPORTED " in
    *" $item "*) ;;
    *) printf '%s\n' "错误: 不支持的组件: $item" >&2; exit 2 ;;
  esac
  probe_reset
  case "$item" in
    java) probe_java ;;
    maven) probe_maven ;;
    gradle)
      C_REQUIRED='0'
      if [ -n "$PROJECT" ] && [ -f "$PROJECT/gradlew" ]; then
        C_STATE='ok'; C_PATH="$PROJECT/gradlew"
        C_NOTES+=('项目自带 gradlew，优先用包装器')
        C_NEXT='用 ./gradlew -v 与真实构建验证'
      elif [ -x "$HOME/.local/jiema-env/gradle"*/bin/gradle ]; then
        for candidate in "$HOME"/.local/jiema-env/gradle*/bin/gradle; do
          [ -x "$candidate" ] && { C_PATH="$candidate"; C_STATE='path-invisible'; break; }
        done
        C_NOTES+=('发现独立前缀里的 Gradle，但不在 PATH')
        C_NEXT='用项目级环境脚本把该目录加入 PATH，或改用 gradlew'
      elif command -v gradle >/dev/null 2>&1; then
        C_PATH="$(command -v gradle)"; C_VERSION="$(gradle --version 2>&1 | awk '/^Gradle/{print $2; exit}')"
        C_STATE='ok'; C_NEXT='gradle 可用仍不够；需真实构建'
      else
        C_STATE='missing'; C_NEXT='仅当项目是 Gradle 构建时才需要 Gradle'
      fi ;;
    node) probe_node ;;
    npm) probe_npm ;;
    yarn|pnpm) probe_generic_version_cmd "$item" "$item" "--version" '0' ;;
    git) probe_git ;;
    python) probe_python ;;
    go) probe_generic_version_cmd go go version '0' ;;
    mysql) probe_database mysql mysql "$MYSQL_PORT" mysqld mysql mysql; probe_mysql_extra ;;
    postgresql) probe_database postgresql psql "$PG_PORT" postgres postgresql postgres ;;
    redis) probe_database redis redis-cli "$REDIS_PORT" redis-server redis redis ;;
    oracle)
      C_STATE='needs-user-input'
      C_NOTES+=('Oracle 需要官方账号下载安装介质，无法自动获取')
      C_NEXT='由用户提供官方安装包与本机实例信息' ;;
    sqlite)
      C_REQUIRED='0'
      if command -v sqlite3 >/dev/null 2>&1; then
        C_STATE='ok'; C_PATH="$(command -v sqlite3)"; C_VERSION="$(sqlite3 --version 2>&1 | first_line)"
        C_NOTES+=('SQLite 无独立服务；必须由项目驱动真实打开数据文件验证')
        C_NEXT='用项目驱动打开数据库文件并跑一次真实读写'
      else
        C_STATE='missing'; C_NEXT='SQLite 随系统/驱动提供；只有需要命令行排查时才装 sqlite3'
      fi ;;
    sqlserver)
      C_STATE='unsupported-on-this-os'
      C_NOTES+=('macOS 没有 SQL Server 服务端；Docker 也不在本技能范围')
      C_NEXT='改用用户确认的 Windows/远程实例，或与用户确认是否换 PostgreSQL'
      C_FORBIDDEN='不要在 macOS 上尝试安装 SQL Server 服务端或偷偷引入容器' ;;
    tomcat) probe_tomcat ;;
    msbuild)
      C_STATE='unsupported-on-this-os'
      C_NOTES+=('MSBuild/.NET Framework 构建链只在 Windows 上可用')
      C_NEXT='C# 项目需要 Windows 机器或远程构建机' ;;
    dotnet)
      C_REQUIRED='0'
      if command -v dotnet >/dev/null 2>&1; then
        C_STATE='ok'; C_PATH="$(command -v dotnet)"; C_VERSION="$(dotnet --version 2>&1 | first_line)"
        C_NOTES+=('dotnet CLI 可用不代表能跑 .NET Framework 桌面程序')
        C_NEXT='确认目标框架：net48 需要 Windows；net8.0 可用 dotnet CLI'
      else
        C_STATE='missing'; C_NEXT='仅当项目目标框架是 net5.0+ 时才需要 .NET SDK'
      fi ;;
    wxdevtools)
      C_REQUIRED='0'
      if [ -d /Applications/wechatwebdevtools.app ] || [ -d "$HOME/Applications/wechatwebdevtools.app" ]; then
        C_STATE='ok'; C_PATH='/Applications/wechatwebdevtools.app'
        C_NOTES+=('发现微信开发者工具；仍需真实打开并编译小程序')
        C_NEXT='导入项目并实际编译/预览一次'
      else
        C_STATE='missing'
        C_NEXT='小程序目标才需要微信开发者工具（官方下载，需图形界面登录）'
      fi ;;
  esac
  emit_component "$item"
done

PLATFORM_RECORD=$(cat <<EOF
{"type":"platform","schemaVersion":1,"platform":"macos","os":$(jstr "$OS_VERSION"),"osBuild":$(jstr "$OS_BUILD"),"arch":$(jstr "$ARCH"),"project":$(jstr_or_null "$PROJECT"),"persistentPath":$(jarr "${PERSISTENT_PATHS[@]:-}"),"persistentPathSources":$(jarr "${PERSISTENT_SOURCES[@]:-}"),"processPath":$(jarr "${PROCESS_PATHS[@]:-}"),"processOnlyPath":$(jarr "${PROCESS_ONLY[@]:-}"),"injectedPath":$(jarr "${INJECTED[@]:-}"),"home":$(jstr "$HOME")}
EOF
)

SUMMARY_RECORD="{\"type\":\"summary\",\"schemaVersion\":1,\"platform\":\"macos\",\"componentCount\":${#RECORDS[@]},\"nonOkCount\":${BAD_STATES},\"nextStep\":$(jstr '按组件状态生成计划：一次只处理一个组件，逐项取得授权')}"

if [ "$JSON_MODE" = '1' ]; then
  printf '%s\n' "$PLATFORM_RECORD"
  for rec in "${RECORDS[@]:-}"; do printf '%s\n' "$rec"; done
  printf '%s\n' "$SUMMARY_RECORD"
else
  printf 'macOS %s (%s)  项目: %s\n' "$OS_VERSION" "$ARCH" "${PROJECT:-未指定}"
  printf '持久化 PATH 来源: %s\n' "$( [ "${#PERSISTENT_SOURCES[@]}" -gt 0 ] && printf '%s ' "${PERSISTENT_SOURCES[@]:-}" || printf '未发现用户 shell 配置' )"
  printf '仅进程可见（宿主/IDE 注入）: %s\n' "$( [ "${#INJECTED[@]}" -gt 0 ] && printf '%s ' "${INJECTED[@]:-}" || printf '无' )"
  printf '\n'
  for line in "${HUMAN[@]:-}"; do printf '%s\n' "$line"; done
  printf '\n非 ok 组件: %s\n' "$BAD_STATES"
fi

[ "$BAD_STATES" -eq 0 ] && exit 0
exit 1
