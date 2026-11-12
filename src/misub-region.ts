// 节点地区识别（纯函数，便于单测）：MiSub 手工节点按名称与分组猜地区，供面板按地区筛选。

// 地区：先认节点名里的旗帜 emoji，再认中英文关键词；都认不出返回空串。

const REGION_KEYWORDS: Array<[string, string[], string[]]> = [
  // [ISO 代码, 中文/长英文关键词（包含即命中）, 需要词边界的短英文代码]
  ["HK", ["香港", "港", "hong kong", "hongkong"], ["HK", "HKG"]],
  ["MO", ["澳门", "澳門", "macau", "macao"], ["MO"]],
  ["TW", ["台湾", "台灣", "臺灣", "台北", "taiwan", "taipei"], ["TW", "TWN"]],
  ["JP", ["日本", "东京", "東京", "大阪", "japan", "tokyo", "osaka"], ["JP", "JPN"]],
  ["SG", ["新加坡", "狮城", "獅城", "singapore"], ["SG", "SGP"]],
  ["KR", ["韩国", "韓國", "首尔", "首爾", "korea", "seoul"], ["KR", "KOR"]],
  ["US", ["美国", "美國", "洛杉矶", "硅谷", "圣何塞", "西雅图", "纽约", "芝加哥", "达拉斯", "united states", "america", "los angeles", "san jose", "seattle", "new york"], ["US", "USA"]],
  ["GB", ["英国", "英國", "伦敦", "united kingdom", "britain", "london"], ["UK", "GB", "GBR"]],
  ["DE", ["德国", "德國", "法兰克福", "germany", "frankfurt"], ["DE", "DEU"]],
  ["FR", ["法国", "法國", "巴黎", "france", "paris"], ["FR", "FRA"]],
  ["NL", ["荷兰", "荷蘭", "阿姆斯特丹", "netherlands", "amsterdam"], ["NL", "NLD"]],
  ["CA", ["加拿大", "canada", "toronto"], ["CA", "CAN"]],
  ["AU", ["澳大利亚", "澳洲", "悉尼", "australia", "sydney"], ["AU", "AUS"]],
  ["RU", ["俄罗斯", "俄羅斯", "莫斯科", "russia", "moscow"], ["RU", "RUS"]],
  ["ID", ["印度尼西亚", "印尼", "雅加达", "indonesia", "jakarta"], []],
  ["IN", ["印度", "孟买", "india", "mumbai"], []],
  ["TR", ["土耳其", "turkey", "türkiye", "istanbul"], ["TR"]],
  ["MY", ["马来西亚", "馬來西亞", "吉隆坡", "malaysia"], ["MY"]],
  ["TH", ["泰国", "泰國", "曼谷", "thailand", "bangkok"], ["TH"]],
  ["VN", ["越南", "vietnam"], ["VN"]],
  ["PH", ["菲律宾", "菲律賓", "philippines", "manila"], ["PH"]],
  ["AE", ["阿联酋", "迪拜", "dubai", "emirates"], ["UAE"]],
  ["AR", ["阿根廷", "argentina"], []],
  ["BR", ["巴西", "brazil"], []],
  ["MX", ["墨西哥", "mexico"], []],
  ["IT", ["意大利", "italy", "milan"], []],
  ["ES", ["西班牙", "spain", "madrid"], []],
  ["CH", ["瑞士", "switzerland", "zurich"], []],
  ["SE", ["瑞典", "sweden", "stockholm"], []],
  ["IE", ["爱尔兰", "愛爾蘭", "ireland", "dublin"], []],
  ["PL", ["波兰", "poland", "warsaw"], []],
  ["IL", ["以色列", "israel"], []],
  ["ZA", ["南非", "south africa"], []],
  ["CN", ["中国", "回国", "china"], ["CN"]],
];

export function detectRegion(name: string): string {
  const text = typeof name === "string" ? name : "";
  if (!text) return "";
  const chars = Array.from(text);
  for (let i = 0; i + 1 < chars.length; i++) {
    const a = chars[i]!.codePointAt(0) ?? 0;
    const b = chars[i + 1]!.codePointAt(0) ?? 0;
    if (a >= 0x1f1e6 && a <= 0x1f1ff && b >= 0x1f1e6 && b <= 0x1f1ff) {
      const code = String.fromCharCode(65 + a - 0x1f1e6) + String.fromCharCode(65 + b - 0x1f1e6);
      return code === "UK" ? "GB" : code;
    }
  }
  const lower = text.toLowerCase();
  // 「港」单字太宽，放到最后兜底，避免「港」误伤其它地区的长关键词。
  for (const [code, words, codes] of REGION_KEYWORDS) {
    for (const w of words) if (w.length > 1 && lower.includes(w)) return code;
    for (const c of codes) {
      if (new RegExp("(^|[^A-Za-z0-9])" + c + "(?=[^A-Za-z]|$)").test(text)) return code;
    }
  }
  if (text.includes("港")) return "HK";
  return "";
}
