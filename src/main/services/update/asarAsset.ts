import type { AsarAsset } from '../../../shared/updateTypes.js'

/** Select the wire asset consistently for status snapshots and downloads. */
export function selectAsarDownloadAsset(asset: AsarAsset): AsarAsset {
    return asset.compressed?.encoding === 'br' ? asset.compressed : asset
}
