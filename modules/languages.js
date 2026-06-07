export const SCRIPTS = {
  cjk: 'cjk',
  latin: 'latin',
  arabic: 'arabic',
  devanagari: 'devanagari',
  thai: 'thai',
  cyrillic: 'cyrillic',
  korean: 'korean',
  greek: 'greek',
  hebrew: 'hebrew',
  other: 'other',
};

const LANGUAGES = [
  { code: 'en', iso: 'eng', name: { en: 'English', zh: '英语', ja: '英語', ko: '영어' }, script: SCRIPTS.latin, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'zh', iso: 'zho', name: { en: 'Chinese', zh: '中文', ja: '中国語', ko: '중국어' }, script: SCRIPTS.cjk, rtl: false, endings: ['。', '！', '？', '」', '』', '）'] },
  { code: 'ja', iso: 'jpn', name: { en: 'Japanese', zh: '日语', ja: '日本語', ko: '일본어' }, script: SCRIPTS.cjk, rtl: false, endings: ['。', '！', '？', '」', '』', '）'] },
  { code: 'ko', iso: 'kor', name: { en: 'Korean', zh: '韩语', ja: '韓国語', ko: '한국어' }, script: SCRIPTS.korean, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'fr', iso: 'fra', name: { en: 'French', zh: '法语', ja: 'フランス語', ko: '프랑스어' }, script: SCRIPTS.latin, rtl: false, endings: ['.', '!', '?', '"', ')', '»'] },
  { code: 'de', iso: 'deu', name: { en: 'German', zh: '德语', ja: 'ドイツ語', ko: '독일어' }, script: SCRIPTS.latin, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'es', iso: 'spa', name: { en: 'Spanish', zh: '西班牙语', ja: 'スペイン語', ko: '스페인어' }, script: SCRIPTS.latin, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'pt', iso: 'por', name: { en: 'Portuguese', zh: '葡萄牙语', ja: 'ポルトガル語', ko: '포르투갈어' }, script: SCRIPTS.latin, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'ru', iso: 'rus', name: { en: 'Russian', zh: '俄语', ja: 'ロシア語', ko: '러시아어' }, script: SCRIPTS.cyrillic, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'ar', iso: 'ara', name: { en: 'Arabic', zh: '阿拉伯语', ja: 'アラビア語', ko: '아랍어' }, script: SCRIPTS.arabic, rtl: true, endings: ['؟', '!', '»', ')'] },
  { code: 'hi', iso: 'hin', name: { en: 'Hindi', zh: '印地语', ja: 'ヒンディー語', ko: '힌디어' }, script: SCRIPTS.devanagari, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'th', iso: 'tha', name: { en: 'Thai', zh: '泰语', ja: 'タイ語', ko: '태국어' }, script: SCRIPTS.thai, rtl: false, endings: ['ฯ', '๚', '๛', '.', '!', '?'] },
  { code: 'vi', iso: 'vie', name: { en: 'Vietnamese', zh: '越南语', ja: 'ベトナム語', ko: '베트남어' }, script: SCRIPTS.latin, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'it', iso: 'ita', name: { en: 'Italian', zh: '意大利语', ja: 'イタリア語', ko: '이탈리아어' }, script: SCRIPTS.latin, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'nl', iso: 'nld', name: { en: 'Dutch', zh: '荷兰语', ja: 'オランダ語', ko: '네덜란드어' }, script: SCRIPTS.latin, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'pl', iso: 'pol', name: { en: 'Polish', zh: '波兰语', ja: 'ポーランド語', ko: '폴란드어' }, script: SCRIPTS.latin, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'tr', iso: 'tur', name: { en: 'Turkish', zh: '土耳其语', ja: 'トルコ語', ko: '터키어' }, script: SCRIPTS.latin, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'id', iso: 'ind', name: { en: 'Indonesian', zh: '印尼语', ja: 'インドネシア語', ko: '인도네시아어' }, script: SCRIPTS.latin, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'ms', iso: 'msa', name: { en: 'Malay', zh: '马来语', ja: 'マレー語', ko: '말레이어' }, script: SCRIPTS.latin, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'tl', iso: 'tgl', name: { en: 'Tagalog', zh: '他加禄语', ja: 'タガログ語', ko: '타갈로그어' }, script: SCRIPTS.latin, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'sv', iso: 'swe', name: { en: 'Swedish', zh: '瑞典语', ja: 'スウェーデン語', ko: '스웨덴어' }, script: SCRIPTS.latin, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'da', iso: 'dan', name: { en: 'Danish', zh: '丹麦语', ja: 'デンマーク語', ko: '덴마크어' }, script: SCRIPTS.latin, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'fi', iso: 'fin', name: { en: 'Finnish', zh: '芬兰语', ja: 'フィンランド語', ko: '핀란드어' }, script: SCRIPTS.latin, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'no', iso: 'nor', name: { en: 'Norwegian', zh: '挪威语', ja: 'ノルウェー語', ko: '노르웨이어' }, script: SCRIPTS.latin, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'cs', iso: 'ces', name: { en: 'Czech', zh: '捷克语', ja: 'チェコ語', ko: '체코어' }, script: SCRIPTS.latin, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'hu', iso: 'hun', name: { en: 'Hungarian', zh: '匈牙利语', ja: 'ハンガリー語', ko: '헝가리어' }, script: SCRIPTS.latin, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'ro', iso: 'ron', name: { en: 'Romanian', zh: '罗马尼亚语', ja: 'ルーマニア語', ko: '루마니아어' }, script: SCRIPTS.latin, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'uk', iso: 'ukr', name: { en: 'Ukrainian', zh: '乌克兰语', ja: 'ウクライナ語', ko: '우크라이나어' }, script: SCRIPTS.cyrillic, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'el', iso: 'ell', name: { en: 'Greek', zh: '希腊语', ja: 'ギリシャ語', ko: '그리스어' }, script: SCRIPTS.greek, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'he', iso: 'heb', name: { en: 'Hebrew', zh: '希伯来语', ja: 'ヘブライ語', ko: '히브리어' }, script: SCRIPTS.hebrew, rtl: true, endings: ['.', '!', '?', '"', ')'] },
  { code: 'bn', iso: 'ben', name: { en: 'Bengali', zh: '孟加拉语', ja: 'ベンガル語', ko: '벵골어' }, script: SCRIPTS.devanagari, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'ta', iso: 'tam', name: { en: 'Tamil', zh: '泰米尔语', ja: 'タミル語', ko: '타밀어' }, script: SCRIPTS.devanagari, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'te', iso: 'tel', name: { en: 'Telugu', zh: '泰卢固语', ja: 'テルグ語', ko: '텔루구어' }, script: SCRIPTS.devanagari, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'mr', iso: 'mar', name: { en: 'Marathi', zh: '马拉地语', ja: 'マラーティー語', ko: '마라티어' }, script: SCRIPTS.devanagari, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'ur', iso: 'urd', name: { en: 'Urdu', zh: '乌尔都语', ja: 'ウルドゥー語', ko: '우르두어' }, script: SCRIPTS.arabic, rtl: true, endings: ['؟', '!', '»', ')'] },
  { code: 'fa', iso: 'fas', name: { en: 'Persian', zh: '波斯语', ja: 'ペルシア語', ko: '페르시아어' }, script: SCRIPTS.arabic, rtl: true, endings: ['؟', '!', '»', ')'] },
  { code: 'ne', iso: 'nep', name: { en: 'Nepali', zh: '尼泊尔语', ja: 'ネパール語', ko: '네팔어' }, script: SCRIPTS.devanagari, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'km', iso: 'khm', name: { en: 'Khmer', zh: '高棉语', ja: 'クメール語', ko: '크메르어' }, script: SCRIPTS.other, rtl: false, endings: ['។', '៕', '!', '?'] },
  { code: 'my', iso: 'mya', name: { en: 'Burmese', zh: '缅甸语', ja: 'ミャンマー語', ko: '미얀마어' }, script: SCRIPTS.other, rtl: false, endings: ['။', '!', '?'] },
  { code: 'lo', iso: 'lao', name: { en: 'Lao', zh: '老挝语', ja: 'ラオス語', ko: '라오어' }, script: SCRIPTS.thai, rtl: false, endings: ['ໆ', '!', '?', '.'] },
  { code: 'ka', iso: 'kat', name: { en: 'Georgian', zh: '格鲁吉亚语', ja: 'グルジア語', ko: '조지아어' }, script: SCRIPTS.other, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'hy', iso: 'hye', name: { en: 'Armenian', zh: '亚美尼亚语', ja: 'アルメニア語', ko: '아르메니아어' }, script: SCRIPTS.other, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'az', iso: 'aze', name: { en: 'Azerbaijani', zh: '阿塞拜疆语', ja: 'アゼルバイジャン語', ko: '아제르바이잔어' }, script: SCRIPTS.latin, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'af', iso: 'afr', name: { en: 'Afrikaans', zh: '南非荷兰语', ja: 'アフリカーンス語', ko: '아프리칸스어' }, script: SCRIPTS.latin, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'sq', iso: 'sqi', name: { en: 'Albanian', zh: '阿尔巴尼亚语', ja: 'アルバニア語', ko: '알바니아어' }, script: SCRIPTS.latin, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'am', iso: 'amh', name: { en: 'Amharic', zh: '阿姆哈拉语', ja: 'アムハラ語', ko: '암하라어' }, script: SCRIPTS.other, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'eu', iso: 'eus', name: { en: 'Basque', zh: '巴斯克语', ja: 'バスク語', ko: '바스크어' }, script: SCRIPTS.latin, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'be', iso: 'bel', name: { en: 'Belarusian', zh: '白俄罗斯语', ja: 'ベラルーシ語', ko: '벨라루스어' }, script: SCRIPTS.cyrillic, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'bs', iso: 'bos', name: { en: 'Bosnian', zh: '波斯尼亚语', ja: 'ボスニア語', ko: '보스니아어' }, script: SCRIPTS.latin, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'bg', iso: 'bul', name: { en: 'Bulgarian', zh: '保加利亚语', ja: 'ブルガリア語', ko: '불가리아어' }, script: SCRIPTS.cyrillic, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'ca', iso: 'cat', name: { en: 'Catalan', zh: '加泰罗尼亚语', ja: 'カタルーニャ語', ko: '카탈루냐어' }, script: SCRIPTS.latin, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'hr', iso: 'hrv', name: { en: 'Croatian', zh: '克罗地亚语', ja: 'クロアチア語', ko: '크로아티아어' }, script: SCRIPTS.latin, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'et', iso: 'est', name: { en: 'Estonian', zh: '爱沙尼亚语', ja: 'エストニア語', ko: '에스토니아어' }, script: SCRIPTS.latin, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'gl', iso: 'glg', name: { en: 'Galician', zh: '加利西亚语', ja: 'ガリシア語', ko: '갈리시아어' }, script: SCRIPTS.latin, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'is', iso: 'isl', name: { en: 'Icelandic', zh: '冰岛语', ja: 'アイスランド語', ko: '아이슬란드어' }, script: SCRIPTS.latin, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'lv', iso: 'lav', name: { en: 'Latvian', zh: '拉脱维亚语', ja: 'ラトビア語', ko: '라트비아어' }, script: SCRIPTS.latin, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'lt', iso: 'lit', name: { en: 'Lithuanian', zh: '立陶宛语', ja: 'リトアニア語', ko: '리투아니아어' }, script: SCRIPTS.latin, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'mk', iso: 'mkd', name: { en: 'Macedonian', zh: '马其顿语', ja: 'マケドニア語', ko: '마케도니아어' }, script: SCRIPTS.cyrillic, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'mt', iso: 'mlt', name: { en: 'Maltese', zh: '马耳他语', ja: 'マルタ語', ko: '몰타어' }, script: SCRIPTS.latin, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'mn', iso: 'mon', name: { en: 'Mongolian', zh: '蒙古语', ja: 'モンゴル語', ko: '몽골어' }, script: SCRIPTS.cyrillic, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'sr', iso: 'srp', name: { en: 'Serbian', zh: '塞尔维亚语', ja: 'セルビア語', ko: '세르비아어' }, script: SCRIPTS.cyrillic, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'sk', iso: 'slk', name: { en: 'Slovak', zh: '斯洛伐克语', ja: 'スロバキア語', ko: '슬로바키아어' }, script: SCRIPTS.latin, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'sl', iso: 'slv', name: { en: 'Slovenian', zh: '斯洛文尼亚语', ja: 'スロベニア語', ko: '슬로베니아어' }, script: SCRIPTS.latin, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'sw', iso: 'swa', name: { en: 'Swahili', zh: '斯瓦希里语', ja: 'スワヒリ語', ko: '스와힐리어' }, script: SCRIPTS.latin, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'tg', iso: 'tgk', name: { en: 'Tajik', zh: '塔吉克语', ja: 'タジク語', ko: '타지크어' }, script: SCRIPTS.cyrillic, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'uz', iso: 'uzb', name: { en: 'Uzbek', zh: '乌兹别克语', ja: 'ウズベク語', ko: '우즈베크어' }, script: SCRIPTS.latin, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'cy', iso: 'cym', name: { en: 'Welsh', zh: '威尔士语', ja: 'ウェールズ語', ko: '웨일스어' }, script: SCRIPTS.latin, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'yi', iso: 'yid', name: { en: 'Yiddish', zh: '意第绪语', ja: 'イディッシュ語', ko: '이디시어' }, script: SCRIPTS.hebrew, rtl: true, endings: ['.', '!', '?', '"', ')'] },
  { code: 'zu', iso: 'zul', name: { en: 'Zulu', zh: '祖鲁语', ja: 'ズールー語', ko: '줄루어' }, script: SCRIPTS.latin, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'jw', iso: 'jav', name: { en: 'Javanese', zh: '爪哇语', ja: 'ジャワ語', ko: '자바어' }, script: SCRIPTS.latin, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'su', iso: 'sun', name: { en: 'Sundanese', zh: '巽他语', ja: 'スンダ語', ko: '순다어' }, script: SCRIPTS.latin, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'ml', iso: 'mal', name: { en: 'Malayalam', zh: '马拉雅拉姆语', ja: 'マラヤーラム語', ko: '말라얄람어' }, script: SCRIPTS.devanagari, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'kn', iso: 'kan', name: { en: 'Kannada', zh: '卡纳达语', ja: 'カンナダ語', ko: '칸나다어' }, script: SCRIPTS.devanagari, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'gu', iso: 'guj', name: { en: 'Gujarati', zh: '古吉拉特语', ja: 'グジャラート語', ko: '구자라트어' }, script: SCRIPTS.devanagari, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'pa', iso: 'pan', name: { en: 'Punjabi', zh: '旁遮普语', ja: 'パンジャブ語', ko: '펀자브어' }, script: SCRIPTS.devanagari, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'or', iso: 'ori', name: { en: 'Odia', zh: '奥里亚语', ja: 'オリヤー語', ko: '오리야어' }, script: SCRIPTS.devanagari, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'as', iso: 'asm', name: { en: 'Assamese', zh: '阿萨姆语', ja: 'アッサム語', ko: '아삼어' }, script: SCRIPTS.devanagari, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'si', iso: 'sin', name: { en: 'Sinhala', zh: '僧伽罗语', ja: 'シンハラ語', ko: '신할라어' }, script: SCRIPTS.other, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'kk', iso: 'kaz', name: { en: 'Kazakh', zh: '哈萨克语', ja: 'カザフ語', ko: '카자흐어' }, script: SCRIPTS.cyrillic, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'ky', iso: 'kir', name: { en: 'Kyrgyz', zh: '吉尔吉斯语', ja: 'キルギス語', ko: '키르기스어' }, script: SCRIPTS.cyrillic, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'tk', iso: 'tuk', name: { en: 'Turkmen', zh: '土库曼语', ja: 'トルクメン語', ko: '투르크멘어' }, script: SCRIPTS.latin, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'ps', iso: 'pus', name: { en: 'Pashto', zh: '普什图语', ja: 'パシュトー語', ko: '파슈토어' }, script: SCRIPTS.arabic, rtl: true, endings: ['؟', '!', '»', ')'] },
  { code: 'sd', iso: 'snd', name: { en: 'Sindhi', zh: '信德语', ja: 'シンド語', ko: '신디어' }, script: SCRIPTS.arabic, rtl: true, endings: ['؟', '!', '»', ')'] },
  { code: 'ha', iso: 'hau', name: { en: 'Hausa', zh: '豪萨语', ja: 'ハウサ語', ko: '하우사어' }, script: SCRIPTS.latin, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'yo', iso: 'yor', name: { en: 'Yoruba', zh: '约鲁巴语', ja: 'ヨルバ語', ko: '요루바어' }, script: SCRIPTS.latin, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'ig', iso: 'ibo', name: { en: 'Igbo', zh: '伊博语', ja: 'イボ語', ko: '이그보어' }, script: SCRIPTS.latin, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'so', iso: 'som', name: { en: 'Somali', zh: '索马里语', ja: 'ソマリ語', ko: '소말리어' }, script: SCRIPTS.latin, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'ny', iso: 'nya', name: { en: 'Chichewa', zh: '齐切瓦语', ja: 'チェワ語', ko: '체와어' }, script: SCRIPTS.latin, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'mg', iso: 'mlg', name: { en: 'Malagasy', zh: '马达加斯加语', ja: 'マダガスカル語', ko: '마다가스카르어' }, script: SCRIPTS.latin, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'eo', iso: 'epo', name: { en: 'Esperanto', zh: '世界语', ja: 'エスペラント語', ko: '에스페란토어' }, script: SCRIPTS.latin, rtl: false, endings: ['.', '!', '?', '"', ')'] },
  { code: 'la', iso: 'lat', name: { en: 'Latin', zh: '拉丁语', ja: 'ラテン語', ko: '라틴어' }, script: SCRIPTS.latin, rtl: false, endings: ['.', '!', '?', '"', ')'] },
];

export function getLanguage(code) {
  return LANGUAGES.find(l => l.code === code) || null;
}

export function getLanguageByName(name, uiLang = 'en') {
  const lower = name.toLowerCase();
  return LANGUAGES.find(l =>
    l.name.en.toLowerCase() === lower ||
    (l.name[uiLang] && l.name[uiLang].toLowerCase() === lower) ||
    l.code === lower
  ) || null;
}

export function getLanguageDisplayName(code, uiLang = 'en') {
  const lang = getLanguage(code);
  if (!lang) return code;
  return lang.name[uiLang] || lang.name.en || code;
}

export function getAllLanguages() {
  return [...LANGUAGES];
}

export function getLanguagesByScript(script) {
  return LANGUAGES.filter(l => l.script === script);
}

export function getRtlLanguages() {
  return LANGUAGES.filter(l => l.rtl);
}

export function getSentenceEndings(code) {
  const lang = getLanguage(code);
  return lang ? lang.endings : ['.', '!', '?'];
}

export function getScript(code) {
  const lang = getLanguage(code);
  return lang ? lang.script : SCRIPTS.latin;
}

export function isRtl(code) {
  const lang = getLanguage(code);
  return lang ? lang.rtl : false;
}

export { LANGUAGES };
