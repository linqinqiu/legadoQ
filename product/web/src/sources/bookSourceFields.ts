// 书源结构化编辑器的字段清单，逐条移植自上游 legado-team/modules/web 的
// src/config/bookSourceEditConfig.ts（段评 ruleReview 一并保留：引擎目前不消费这些规则，
// 但字段仍需在编辑时可见可存，否则导入的书源一改就丢配置）。
export type SourceField = {
  id: string
  title: string
  type: 'String' | 'Boolean' | 'Number' | 'Array'
  /** 嵌套在哪条规则下，如 ruleSearch；缺省表示书源根对象 */
  ns?: string
  hint?: string
  required?: boolean
  array?: string[]
}

export type SourceFieldGroup = { key: string; name: string; fields: SourceField[] }

export const SOURCE_FIELD_GROUPS: SourceFieldGroup[] = [
 {
  "key": "base",
  "name": "基础",
  "fields": [
   {
    "id": "bookSourceType",
    "title": "源类型",
    "type": "Array",
    "required": true,
    "array": [
     "文本",
     "音频",
     "图片",
     "文件",
     "视频"
    ]
   },
   {
    "id": "bookSourceUrl",
    "title": "源域名",
    "type": "String",
    "hint": "通常填写网站主页，例: https://www.qidian.com",
    "required": true
   },
   {
    "id": "bookSourceName",
    "title": "源名称",
    "type": "String",
    "hint": "会显示在源列表",
    "required": true
   },
   {
    "id": "bookSourceGroup",
    "title": "源分组",
    "type": "String",
    "hint": "描述源的特征信息"
   },
   {
    "id": "bookSourceComment",
    "title": "源注释",
    "type": "String",
    "hint": "描述源作者和状态"
   },
   {
    "id": "loginUrl",
    "title": "登录地址",
    "type": "String",
    "hint": "填写网站登录网址，仅在需要登录的源有用"
   },
   {
    "id": "loginUi",
    "title": "登录界面",
    "type": "String",
    "hint": "自定义登录界面"
   },
   {
    "id": "loginCheckJs",
    "title": "登录检测",
    "type": "String",
    "hint": "登录检测js"
   },
   {
    "id": "coverDecodeJs",
    "title": "封面解密",
    "type": "String",
    "hint": "封面解密js"
   },
   {
    "id": "bookUrlPattern",
    "title": "链接验证",
    "type": "String",
    "hint": "书籍URL正则，当详情页URL与源URL的域名不一致时有效，用于添加网址"
   },
   {
    "id": "header",
    "title": "请求头",
    "type": "String",
    "hint": "客户端标识"
   },
   {
    "id": "variableComment",
    "title": "变量说明",
    "type": "String",
    "hint": "书源变量说明"
   },
   {
    "id": "concurrentRate",
    "title": "并发率",
    "type": "String",
    "hint": "并发率，如1000（访问间隔1000ms）或者1/1000（1000ms内访问1次）"
   },
   {
    "id": "jsLib",
    "title": "js库",
    "type": "String",
    "hint": "js库，可填写js或者key-value object获取在线js文件"
   }
  ]
 },
 {
  "key": "search",
  "name": "搜索",
  "fields": [
   {
    "id": "searchUrl",
    "title": "搜索地址",
    "type": "String",
    "hint": "[域名可省略]/search.php@kw={{key}}"
   },
   {
    "id": "checkKeyWord",
    "title": "校验文字",
    "type": "String",
    "ns": "ruleSearch",
    "hint": "校验关键字，强烈建议填写"
   },
   {
    "id": "bookList",
    "title": "列表规则",
    "type": "String",
    "ns": "ruleSearch",
    "hint": "选择书籍节点（规则结果为List<Element>）"
   },
   {
    "id": "name",
    "title": "书名规则",
    "type": "String",
    "ns": "ruleSearch",
    "hint": "选择节点书名（规则结果为String）"
   },
   {
    "id": "author",
    "title": "作者规则",
    "type": "String",
    "ns": "ruleSearch",
    "hint": "选择节点作者（规则结果为String）"
   },
   {
    "id": "kind",
    "title": "分类规则",
    "type": "String",
    "ns": "ruleSearch",
    "hint": "选择节点分类信息（规则结果为String）"
   },
   {
    "id": "wordCount",
    "title": "字数规则",
    "type": "String",
    "ns": "ruleSearch",
    "hint": "选择节点字数信息（规则结果为String）"
   },
   {
    "id": "lastChapter",
    "title": "最新章节",
    "type": "String",
    "ns": "ruleSearch",
    "hint": "选择节点最新章节（规则结果为String）"
   },
   {
    "id": "intro",
    "title": "简介规则",
    "type": "String",
    "ns": "ruleSearch",
    "hint": "选择节点书籍简介（规则结果为String）"
   },
   {
    "id": "coverUrl",
    "title": "封面规则",
    "type": "String",
    "ns": "ruleSearch",
    "hint": "选择节点书籍封面（规则结果为String类型的url）"
   },
   {
    "id": "bookUrl",
    "title": "详情地址",
    "type": "String",
    "ns": "ruleSearch",
    "hint": "选择书籍详情页网址（规则结果为String类型的url）"
   }
  ]
 },
 {
  "key": "find",
  "name": "发现",
  "fields": [
   {
    "id": "exploreUrl",
    "title": "发现地址",
    "type": "String",
    "hint": "单个发现格式<name>::<url>或者{url:<url>,title:<name>,style:…}；前者用换行符或者&&连接，后者放在数组内；可用js动态生成"
   },
   {
    "id": "bookList",
    "title": "列表规则",
    "type": "String",
    "ns": "ruleExplore",
    "hint": "选择书籍节点（规则结果为List<Element>）"
   },
   {
    "id": "name",
    "title": "书名规则",
    "type": "String",
    "ns": "ruleExplore",
    "hint": "选择节点书名（规则结果为String）"
   },
   {
    "id": "author",
    "title": "作者规则",
    "type": "String",
    "ns": "ruleExplore",
    "hint": "选择节点作者（规则结果为String）"
   },
   {
    "id": "kind",
    "title": "分类规则",
    "type": "String",
    "ns": "ruleExplore",
    "hint": "选择节点分类信息（规则结果为String）"
   },
   {
    "id": "wordCount",
    "title": "字数规则",
    "type": "String",
    "ns": "ruleExplore",
    "hint": "选择节点字数信息（规则结果为String）"
   },
   {
    "id": "lastChapter",
    "title": "最新章节",
    "type": "String",
    "ns": "ruleExplore",
    "hint": "选择节点最新章节（规则结果为String）"
   },
   {
    "id": "intro",
    "title": "简介规则",
    "type": "String",
    "ns": "ruleExplore",
    "hint": "选择节点书籍简介（规则结果为String）"
   },
   {
    "id": "coverUrl",
    "title": "封面规则",
    "type": "String",
    "ns": "ruleExplore",
    "hint": "选择节点书籍封面（规则结果为String类型的url）"
   },
   {
    "id": "bookUrl",
    "title": "详情地址",
    "type": "String",
    "ns": "ruleExplore",
    "hint": "选择书籍详情页网址（规则结果为String类型的url）"
   }
  ]
 },
 {
  "key": "detail",
  "name": "详情",
  "fields": [
   {
    "id": "init",
    "title": "预处理",
    "type": "String",
    "ns": "ruleBookInfo",
    "hint": "用于加速详情信息检索，只支持AllInOne规则"
   },
   {
    "id": "name",
    "title": "书名规则",
    "type": "String",
    "ns": "ruleBookInfo",
    "hint": "选择节点书名（规则结果为String）"
   },
   {
    "id": "author",
    "title": "作者规则",
    "type": "String",
    "ns": "ruleBookInfo",
    "hint": "选择节点作者（规则结果为String）"
   },
   {
    "id": "kind",
    "title": "分类规则",
    "type": "String",
    "ns": "ruleBookInfo",
    "hint": "选择节点分类信息（规则结果为String）"
   },
   {
    "id": "wordCount",
    "title": "字数规则",
    "type": "String",
    "ns": "ruleBookInfo",
    "hint": "选择节点字数信息（规则结果为String）"
   },
   {
    "id": "lastChapter",
    "title": "最新章节",
    "type": "String",
    "ns": "ruleBookInfo",
    "hint": "选择节点最新章节（规则结果为String）"
   },
   {
    "id": "intro",
    "title": "简介规则",
    "type": "String",
    "ns": "ruleBookInfo",
    "hint": "选择节点书籍简介（规则结果为String）"
   },
   {
    "id": "coverUrl",
    "title": "封面规则",
    "type": "String",
    "ns": "ruleBookInfo",
    "hint": "选择节点书籍封面（规则结果为String类型的url）"
   },
   {
    "id": "tocUrl",
    "title": "目录地址",
    "type": "String",
    "ns": "ruleBookInfo",
    "hint": "选择书籍详情页网址（规则结果为String类型的url, 与详情页相同时可省略）"
   },
   {
    "id": "canReName",
    "title": "修改书籍",
    "type": "String",
    "ns": "ruleBookInfo",
    "hint": "允许修改书名作者（规则结果为String类型，默认不允许）"
   },
   {
    "id": "downloadUrls",
    "title": "下载URL",
    "type": "String",
    "ns": "ruleBookInfo",
    "hint": "文件类书源下载地址（规则结果为String类型的url, 多个链接返回数组）"
   }
  ]
 },
 {
  "key": "directory",
  "name": "目录",
  "fields": [
   {
    "id": "preUpdateJs",
    "title": "更新前JS",
    "type": "String",
    "ns": "ruleToc",
    "hint": "更新目录前调用JS 动态更新目录链接"
   },
   {
    "id": "chapterList",
    "title": "列表规则",
    "type": "String",
    "ns": "ruleToc",
    "hint": "选择目录列表的章节节点（规则结果为List<Element>）"
   },
   {
    "id": "chapterName",
    "title": "章节名称",
    "type": "String",
    "ns": "ruleToc",
    "hint": "选择章节名称（规则结果为String）"
   },
   {
    "id": "chapterUrl",
    "title": "章节地址",
    "type": "String",
    "ns": "ruleToc",
    "hint": "选择章节链接（规则结果为String类型的Url）"
   },
   {
    "id": "formatJs",
    "title": "标题处理",
    "type": "String",
    "ns": "ruleToc",
    "hint": "遍历去重后的章节列表的回调，提供index（章节序号从1开始）、title（章节标题）变量，额外提供gInt（初始值0），返回值作为新的标题"
   },
   {
    "id": "isVolume",
    "title": "卷名标识",
    "type": "String",
    "ns": "ruleToc",
    "hint": "章节名称是否是卷名（规则结果为Bool）"
   },
   {
    "id": "updateTime",
    "title": "章节信息",
    "type": "String",
    "ns": "ruleToc",
    "hint": "选择章节信息（如更新时间）（规则结果为String）"
   },
   {
    "id": "isVip",
    "title": "收费标识",
    "type": "String",
    "ns": "ruleToc",
    "hint": "章节是否为VIP章节（规则结果为Bool）"
   },
   {
    "id": "isPay",
    "title": "购买标识",
    "type": "String",
    "ns": "ruleToc",
    "hint": "章节是否为已购买（规则结果为Bool）"
   },
   {
    "id": "nextTocUrl",
    "title": "翻页规则",
    "type": "String",
    "ns": "ruleToc",
    "hint": "选择目录下一页链接（规则结果为List<String>或String）"
   }
  ]
 },
 {
  "key": "content",
  "name": "正文",
  "fields": [
   {
    "id": "content",
    "title": "正文规则",
    "type": "String",
    "ns": "ruleContent",
    "hint": "选择正文内容（规则结果为String）"
   },
   {
    "id": "subContent",
    "title": "副文规则",
    "type": "String",
    "ns": "ruleContent",
    "hint": "选择副文内容（规则结果为String）"
   },
   {
    "id": "title",
    "title": "标题规则",
    "type": "String",
    "ns": "ruleContent",
    "hint": "获取结果将会覆盖章节标题（规则结果为String）"
   },
   {
    "id": "nextContentUrl",
    "title": "翻页规则",
    "type": "String",
    "ns": "ruleContent",
    "hint": "选择下一分页（不是下一章）链接（规则结果为String类型的Url）"
   },
   {
    "id": "webJs",
    "title": "脚本注入",
    "type": "String",
    "ns": "ruleContent",
    "hint": "注入javascript，用于模拟鼠标点击等，必须有返回值，一般为String类型"
   },
   {
    "id": "sourceRegex",
    "title": "资源正则",
    "type": "String",
    "ns": "ruleContent",
    "hint": "匹配资源的url特征，用于嗅探"
   },
   {
    "id": "replaceRegex",
    "title": "替换规则",
    "type": "String",
    "ns": "ruleContent",
    "hint": "多页内容合并后替换，用于正文净化"
   },
   {
    "id": "imageStyle",
    "title": "图片样式",
    "type": "String",
    "ns": "ruleContent",
    "hint": "FULL:铺满 不填：默认样式"
   },
   {
    "id": "imageDecode",
    "title": "图片解密",
    "type": "String",
    "ns": "ruleContent",
    "hint": "填写JavaScript 返回解密图片的bytes "
   },
   {
    "id": "payAction",
    "title": "购买操作",
    "type": "String",
    "ns": "ruleContent",
    "hint": "填写JavaScript 返回购买链接或者调用购买接口"
   },
   {
    "id": "callBackJs",
    "title": "回调操作",
    "type": "String",
    "ns": "ruleContent",
    "hint": "填写JavaScript 变量event为事件对象名称"
   }
  ]
 },
 {
  "key": "review",
  "name": "段评",
  "fields": [
   {
    "id": "enabled",
    "title": "启用段评",
    "type": "Boolean",
    "ns": "ruleReview"
   },
   {
    "id": "reviewSummaryUrl",
    "title": "段评统计 URL（reviewSummaryUrl）",
    "type": "String",
    "ns": "ruleReview"
   },
   {
    "id": "summaryListRule",
    "title": "段评统计列表（summaryListRule）",
    "type": "String",
    "ns": "ruleReview"
   },
   {
    "id": "summaryParagraphIndexRule",
    "title": "段落索引（summaryParagraphIndexRule）",
    "type": "String",
    "ns": "ruleReview",
    "hint": "返回 -1 表示章评，1 开始表示正文段落"
   },
   {
    "id": "summaryCountRule",
    "title": "段评数量（summaryCountRule）",
    "type": "String",
    "ns": "ruleReview"
   },
   {
    "id": "summaryParagraphDataRule",
    "title": "段落数据（summaryParagraphDataRule）",
    "type": "String",
    "ns": "ruleReview"
   },
   {
    "id": "reviewDetailUrl",
    "title": "段评详情 URL（reviewDetailUrl）",
    "type": "String",
    "ns": "ruleReview"
   },
   {
    "id": "reviewDetailNextPageUrl",
    "title": "段评下一页 URL（reviewDetailNextPageUrl）",
    "type": "String",
    "ns": "ruleReview"
   },
   {
    "id": "detailListRule",
    "title": "段评详情列表（detailListRule）",
    "type": "String",
    "ns": "ruleReview"
   },
   {
    "id": "detailIdRule",
    "title": "段评 ID（detailIdRule）",
    "type": "String",
    "ns": "ruleReview"
   },
   {
    "id": "detailAvatarRule",
    "title": "头像（detailAvatarRule）",
    "type": "String",
    "ns": "ruleReview"
   },
   {
    "id": "detailNameRule",
    "title": "昵称（detailNameRule）",
    "type": "String",
    "ns": "ruleReview"
   },
   {
    "id": "detailBadgeRule",
    "title": "徽章（detailBadgeRule）",
    "type": "String",
    "ns": "ruleReview"
   },
   {
    "id": "detailContentRule",
    "title": "评论内容协议（detailContentRule）",
    "type": "String",
    "ns": "ruleReview",
    "hint": "text/replyToName/img/audio/time/likeCount/replyCount"
   },
   {
    "id": "reviewQuoteUrl",
    "title": "段评回复 URL（reviewQuoteUrl）",
    "type": "String",
    "ns": "ruleReview"
   },
   {
    "id": "replyListRule",
    "title": "子评论列表（replyListRule）",
    "type": "String",
    "ns": "ruleReview"
   },
   {
    "id": "replyIdRule",
    "title": "子评论 ID（replyIdRule）",
    "type": "String",
    "ns": "ruleReview"
   },
   {
    "id": "replyAvatarRule",
    "title": "子评论头像（replyAvatarRule）",
    "type": "String",
    "ns": "ruleReview"
   },
   {
    "id": "replyNameRule",
    "title": "子评论昵称（replyNameRule）",
    "type": "String",
    "ns": "ruleReview"
   },
   {
    "id": "replyBadgeRule",
    "title": "子评论徽章（replyBadgeRule）",
    "type": "String",
    "ns": "ruleReview"
   },
   {
    "id": "replyContentRule",
    "title": "子评论内容协议（replyContentRule）",
    "type": "String",
    "ns": "ruleReview",
    "hint": "text/replyToName/img/audio/time/likeCount"
   }
  ]
 },
 {
  "key": "other",
  "name": "其他",
  "fields": [
   {
    "id": "enabled",
    "title": "启用搜索",
    "type": "Boolean"
   },
   {
    "id": "enabledExplore",
    "title": "启用发现",
    "type": "Boolean"
   },
   {
    "id": "enabledCookieJar",
    "title": "CookieJar",
    "type": "Boolean"
   },
   {
    "id": "eventListener",
    "title": "启用事件监听",
    "type": "Boolean"
   },
   {
    "id": "customButton",
    "title": "启用定制按钮",
    "type": "Boolean"
   },
   {
    "id": "weight",
    "title": "搜索权重",
    "type": "Number"
   },
   {
    "id": "customOrder",
    "title": "排序编号",
    "type": "Number"
   }
  ]
 }
]

