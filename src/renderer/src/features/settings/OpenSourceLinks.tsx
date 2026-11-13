import { APP_SOURCE_URL, SERVER_SOURCE_URL } from '@shared/updates'

export default function OpenSourceLinks() {
  return <div className="software-update-actions" aria-label="开源项目">
    <a className="btn btn-sm" href={APP_SOURCE_URL} target="_blank" rel="noreferrer">PC 客户端源码 ↗</a>
    <a className="btn btn-sm" href={SERVER_SOURCE_URL} target="_blank" rel="noreferrer">后端源码与部署 ↗</a>
  </div>
}
