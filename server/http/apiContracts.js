/** @typedef {{page:number,pageSize:number,total:number,pages:number}} PaginationDto */
/** @typedef {{items: unknown[], pagination: PaginationDto}} PageResponseDto */
/** @typedef {{code:string,message:string,requestId?:string,details?:unknown}} ApiErrorDto */
/** @typedef {{id:string,canonical_title:string,authors:string[],files:unknown[],fileCount?:number}} WorkDto */
/** @typedef {{read:boolean,write:boolean,range:boolean,signedUrls:boolean,multipartUpload:boolean}} StorageCapabilitiesDto */

/**
 * Runtime-facing API contract catalogue. Keep this file synchronized with
 * api/openapi.yaml until the backend is incrementally migrated to TypeScript.
 */
export const apiContractVersion = '1.0.0';
