/** Spanish ACTION/language/prefix links identify the same official HJ decision. */
export function canonicalOfficialArticleUrl(sourceKey:string,value:string) {
  const url=new URL(value);
  if(sourceKey==="es-tribunal-constitucional"&&url.protocol==="https:"&&url.hostname==="hj.tribunalconstitucional.es"&&!url.username&&!url.password&&(!url.port||url.port==="443")) {
    const id=url.pathname.match(/^\/(?:HJ\/)?(?:es|en|fr)\/Resolucion\/Show\/(\d+)\/?$/i)?.[1];
    if(id&&Number.isSafeInteger(Number(id))&&Number(id)>0)return "https://hj.tribunalconstitucional.es/HJ/es/Resolucion/Show/"+String(Number(id));
  }
  return value;
}

