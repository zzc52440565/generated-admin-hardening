@echo off
rem ============================================================
rem  Tomcat setenv.bat 模板（放到 <CATALINA_HOME>\bin\setenv.bat）
rem
rem  为什么需要这个文件：
rem  1) Tomcat 的 setclasspath.bat 先看 JRE_HOME 再看 JAVA_HOME。
rem     残留的 JRE_HOME 指向已删除目录时，startup 与 service.bat 都会
rem     报 "JRE_HOME not defined correctly"。
rem  2) service.bat 根本不加载 setenv.bat，所以注册服务时还要在进程级
rem     覆盖 JRE_HOME。两处都要设，且必须指向同一个 JDK。
rem  => 本文件同时写两个变量，保持完全一致。
rem
rem  编码：保持 ANSI/纯 ASCII；UTF-8 中文注释在 cmd.exe 里会变乱码。
rem ============================================================

rem --- 只改这一行：填真实 JDK 根目录（由环境阶段按实际安装位置渲染）---
set "JAVA_HOME=__JAVA_HOME__"
rem --- 改到这里为止 ---

set "JRE_HOME=%JAVA_HOME%"

rem 可选：本实例默认 JVM 参数
rem set "CATALINA_OPTS=-Xms512m -Xmx1024m -Dfile.encoding=UTF-8"
