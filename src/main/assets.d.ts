/**
 * 构建期资源导入的类型声明
 *
 * Vite 的 `?raw` 后缀会把文件内容作为字符串内联进产物。
 * 用这种方式引入采集脚本，是为了避免运行时按路径找文件 ——
 * 打包成 asar 后目录结构会变，路径查找很容易失效。
 */
declare module '*.sh?raw' {
  const content: string
  export default content
}

declare module '*.txt?raw' {
  const content: string
  export default content
}

declare module '*.md?raw' {
  const content: string
  export default content
}

declare module '*.ps1?raw' {
  const content: string
  export default content
}
