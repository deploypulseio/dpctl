// The MIT License (MIT)

// Copyright (c) 2015 JD Ballard

// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:

// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.

// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

// Original: https://github.com/Qix-/node-backslash/
// On 8 September 2025, the npm publishing account for backslash was taken over after a phishing attack. 
// Version 0.2.1 was published, functionally identical to the previous patch version, but with a malware payload 
// added attempting to redirect cryptocurrency transactions to the attacker's own addresses from within browser
// environments.
// Due to this, we have forked the original functionality here to ensure its continued safe use and 
// converted it to TypeScript.
// Link: https://github.com/Qix-/node-backslash/security/advisories/GHSA-53mq-f4w3-f7qv

export class BackslashError extends Error {
  public readonly offset: number;

  constructor(offset: number, message: string) {
    super(message);
    this.name = "BackslashError";
    this.offset = offset;
  }
}

function isOctalDigit(c: string): boolean {
  return c >= "0" && c <= "7";
}

function isHexDigit(c: string): boolean {
  return (
    (c >= "0" && c <= "9") ||
    (c >= "a" && c <= "f") ||
    (c >= "A" && c <= "F")
  );
}

function parseHex(hex: string): string {
  const cp = Number.parseInt(hex, 16);
  // Equivalent to punycode.ucs2.encode([cp])
  return String.fromCodePoint(cp);
}

type ParseUntilResult = { end: number; value: string };

// Overloads so TS knows which return type you get
function process(str: string, pos: number): string;
function process(str: string, pos: number, stopChar: string): ParseUntilResult;
function process(str: string, pos: number, stopChar?: string): string | ParseUntilResult {
  let escaped = false;
  const ret: string[] = [];

  function assertHexDigit(at: number): string {
    const c = str[at];
    if (!c || !isHexDigit(c)) {
      throw new BackslashError(at, "Unexpected token ILLEGAL");
    }
    return c;
  }

  while (pos < str.length) {
    let c = str[pos];
    pos++;

    if (escaped) {
      escaped = false;

      switch (c) {
        case "n":
          ret.push("\n");
          continue;
        case "r":
          ret.push("\r");
          continue;
        case "f":
          ret.push("\f");
          continue;
        case "b":
          ret.push("\b");
          continue;
        case "t":
          ret.push("\t");
          continue;
        case "v":
          ret.push("\v");
          continue;
        case "\\":
          ret.push("\\");
          continue;
      }

      if (c === "x") {
        ret.push(parseHex(assertHexDigit(pos) + assertHexDigit(pos + 1)));
        pos += 2;
        continue;
      }

      if (c === "u") {
        ret.push(
          parseHex(
            assertHexDigit(pos) +
              assertHexDigit(pos + 1) +
              assertHexDigit(pos + 2) +
              assertHexDigit(pos + 3)
          )
        );
        pos += 4;
        continue;
      }

      if (isOctalDigit(c)) {
        let o = str[pos];
        if (o && isOctalDigit(o)) {
          pos++;
          c += o;

          o = str[pos];
          if (o && isOctalDigit(o) && c[0] <= "3") {
            pos++;
            c += o;
          }
        }

        ret.push(String.fromCodePoint(Number.parseInt(c, 8)));
        continue;
      }

      // default: unknown escape becomes literal char
      ret.push(c);
      continue;
    }

    if (c === "\\") {
      escaped = true;
      continue;
    }

    if (stopChar !== undefined && c === stopChar) {
      pos--; // keep behavior identical to original
      break;
    }

    ret.push(c);
  }

  const value = ret.join("");
  if (stopChar !== undefined) return { end: pos, value };
  return value;
}

export default function backslash(str: string): string {
  return process(str, 0);
}

export function parseUntil(str: string, pos: number, stopChar: string): ParseUntilResult {
  return process(str, pos, stopChar) as ParseUntilResult;
}
