/**
 * 中文 mojibake（乱码）检测（快修：digest / value-judge 共用）。
 *
 * 背景：经 OpenRouter 路由到的某些后端会间歇性返回「双重编码」字节——UTF-8 编码的
 * 中文被当 Latin-1 解码，到客户端时已是 mojibake（如 `æ¬ææ é¢ä¸ºNotes...`）。
 * raw_items 输入是干净的，坏在 per-response 间歇的 LLM 响应，故只有部分条目坏。
 *
 * 判定依据：UTF-8 多字节序列（CJK 必含）被当 Latin-1 解码后，每个续字节 0x80–0xBF
 * 原样落在 U+0080–U+00BF（C1 控制区 + Latin-1 标点/符号区）——一个汉字必产生 2 个这样的
 * 字符，故 mojibake 里它们成片出现。而合法的重音拉丁**字母**（café/naïve/résumé 等）
 * 全在 U+00C0–U+00FF，**不**落在该区间，所以只统计 U+0080–U+00BF 不会误判正常 Latin 文本。
 * 给正常文本里偶发的 Latin-1 符号（©®°±§«» 等，同处该区间）留容差，超过小阈值才判 mojibake。
 *
 * 不做还原：latin1→utf8 还原是有损的（会留 �），命中后一律走重试求干净响应、
 * 不行则降级，绝不输出乱码。
 */

/**
 * U+0080–U+00BF（续字节/C1/Latin-1 符号区）字符计数超过此阈值即判为 mojibake。
 *
 * 取 3（>3 命中，即 ≥4）：mojibake 一个汉字贡献 2 个续字节，≥2 个汉字即触发；
 * 而正常文本偶发的 ©®° 等 Latin-1 符号在 3 个以内不误判。
 */
const MOJIBAKE_THRESHOLD = 3;

/**
 * 判定字符串是否为「UTF-8 被当 Latin-1 解码」的中文 mojibake。
 *
 * 纯函数：只统计落在 U+0080–U+00BF（UTF-8 续字节落点）的字符数，超过 MOJIBAKE_THRESHOLD
 * 即判为 mojibake。**刻意排除 U+00C0–U+00FF**——合法重音拉丁字母居于此，计入会误伤正常文本。
 */
export function looksLikeMojibake(s: string): boolean {
  let count = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (code >= 0x80 && code <= 0xbf) {
      count++;
      if (count > MOJIBAKE_THRESHOLD) return true;
    }
  }
  return false;
}
