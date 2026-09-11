/**
 * 测试配置模板。
 *
 * 复制为 test-config.js（该文件已被 .gitignore 忽略）并填入你自己的目标站点。
 * 测试脚本会优先读取 test-config.js，没有时才用本模板的示例值。
 *
 *   cp test-config.example.js test-config.js
 *
 * 说明：这些测试需要一个"已登录且可安全操作"的页面。
 * 请勿指向生产文档；建议单独建一个测试页。
 */

module.exports = {
  /**
   * 测试页地址。测试会以它的域名部分作为 origin。
   * 必须是当前浏览器已登录、且允许读写的页面。
   */
  pageUrl: 'https://confluence.example.com/pages/viewpage.action?pageId=000000000',

  /**
   * 页面上一个用于验证"点击跳转"的链接文字（可留空跳过相关断言）。
   * 该链接应指向站点内的另一个页面。
   */
  linkText: 'Related page',

  /**
   * 点击 linkText 后，目标页 URL 应包含的片段（用于校验跳转成功）。
   */
  linkTargetFragment: 'pageId=',

  /**
   * 编辑器测试（test-editor.js）使用的页面编辑地址。
   * 留空则 test-editor.js 必须通过 --url 参数指定。
   */
  editUrl: '',

  /** 等待编辑器加载的超时时间（毫秒）。慢站点可调大。 */
  editorLoadTimeoutMs: 8000
};
