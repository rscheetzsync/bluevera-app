
 // BlueVera | api/armls-sold-history-sync.js
 // Administrator-only single-MLS synchronization from armls_sold_properties.
 // Defaults to read-only preview. POST {mlsNumber:"7066432",commit:true} writes.
 // No Spark calls, remarks, rating recalculation, or public exposure.
 import crypto from 'node:crypto';

 const SB = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
 const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || '';
 const normEmail = v => String(v || '').trim().toLowerCase();
 const clean = v => String(v ?? '').trim().replace(/\s+/g, ' ');
 const uuid = () => crypto.randomUUID();
 const SYSTEMS = [
   ['flooring','flooring'], ['electrical','electrical'], ['plumbing','plumbing'],
   ['hvac','hvac'], ['roof','roof'], ['kitchen','kitchen'],
   ['bathrooms','bathrooms'], ['room_additions','room_additions'], ['pool','pool']
 ];

 function err(message, status=400) { return Object.assign(new Error(message), {status}); }
 function normalizeAddress(input) {
   return clean(input).toUpperCase().replace(/[.,#]/g,' ')
     .replace(/\b(ARIZONA|AZ|PHOENIX|GLENDALE|SCOTTSDALE|MESA|TEMPE|CHANDLER|GILBERT)\b/g,' ')
     .replace(/\b\d{5}(?:-\d{4})?\b/g,' ')
     .replace(/\bWEST\b/g,'W').replace(/\bEAST\b/g,'E')
     .replace(/\bNORTH\b/g,'N').replace(/\bSOUTH\b/g,'S')
     .replace(/\bAVENUE\b/g,'AVE').replace(/\bSTREET\b/g,'ST')
     .replace(/\bDRIVE\b/g,'DR').replace(/\bROAD\b/g,'RD')
     .replace(/\bBOULEVARD\b/g,'BLVD').replace(/\bPLACE\b/g,'PL')
     .replace(/\bCOURT\b/g,'CT').replace(/\bLANE\b/g,'LN')
     .replace(/\bCIRCLE\b/g,'CIR').replace(/\bTERRACE\b/g,'TER')
     .replace(/\s+/g,' ').trim();
 }
 function apn(v) { return clean(v).toUpperCase().replace(/[^A-Z0-9]/g,''); }
 function isUnit(a) { return /\b(UNIT|APT|APARTMENT|SUITE|STE)\s*#?\s*\S+|\s#\s*\w+/i.test(clean(a)); }
 function verifiedMatch(sold, prop) {
   const sameAddress = normalizeAddress(sold.property_address) ===
     normalizeAddress(prop.full_address || prop.address || prop.street);
   const soldApn = apn(sold.parcel_number), propertyApn = apn(prop.apn);
   // APNs must not conflict, even when street text matches.
   if (soldApn && propertyApn && soldApn !== propertyApn) return false;
   // Do not ever silently match condos or unit-bearing addresses.
   if (isUnit(sold.property_address) || isUnit(prop.full_address || prop.address)) return false;
   if (!sameAddress) return false;
   const pZip = clean(prop.zip), sZip = clean(sold.zip_code);
   if (pZip && sZip && pZip !== sZip) return false;
   return true;
 }
 function validYear(v) {
   if (v == null || clean(v)==='') return null;
   const n = Number(v);
   return Number.isInteger(n) && n >= 1900 && n <= new Date().getFullYear()+1 ? n : null;
 }
 function updatesFromSold(sold) {
   return SYSTEMS.flatMap(([field,systemType]) => {
     const year = validYear(sold[`${field}_year`]);
     if (!year) return [];
     return [{systemType,year,scope:clean(sold[field]) || null}];
   });
 }
 async function rest(tableAndQuery, options={}) {
   if (!SB || !KEY) throw err('Missing Supabase environment variables.',503);
   const r=await fetch(`${SB}/rest/v1/${tableAndQuery}`,{
     ...options,
     headers:{apikey:KEY,Authorization:`Bearer ${KEY}`,'Content-Type':'application/json',
       ...(options.headers||{})},
     signal:AbortSignal.timeout(16000)
   });
   const t=await r.text(); let data;
   try { data=t?JSON.parse(t):null; } catch { data=t; }
   if(!r.ok) throw err(`Database HTTP ${r.status}: ${typeof data==='string'?data:JSON.stringify(data)?.slice(0,500)}`,502);
   return data;
 }
 async function administrator(req) {
   const bearer=/^Bearer\s+(.+)$/i.exec(String(req.headers.authorization||''));
   if(!bearer) throw err('Sign in to BlueVera admin and send a bearer session token.',401);
   if(!SB || !KEY) throw err('Supabase environment not configured.',503);
   const r=await fetch(`${SB}/auth/v1/user`,{headers:{apikey:KEY,Authorization:`Bearer ${bearer[1]}`},signal:AbortSignal.timeout(10000)});
   if(!r.ok) throw err('Administrator session expired.',401);
   const user=await r.json();
   if(!user?.id || !normEmail(user.email)) throw err('Invalid signed-in user.',401);
   const rows=await rest('admin_users?select=email,role,is_active&is_active=eq.true&limit=100');
   if(!Array.isArray(rows) || !rows.some(a=>a.is_active===true && normEmail(a.email)===normEmail(user.email)
     && ['admin','super_admin'].includes(clean(a.role).toLowerCase()))) {
     throw err('Active administrator authorization required.',403);
   }
 }
 async function getRows(table, query, limit=50) {
   const params=new URLSearchParams({...query,select:'*',limit:String(limit)});
   const rows=await rest(`${table}?${params}`);
   return Array.isArray(rows)?rows:[];
 }
 async function chooseProperty(sold) {
   const address=clean(sold.property_address);
   const m=/^(\d+[A-Z]?)\s+([NSEW])?\s*(\S+)/i.exec(address);
   if(!m) throw err('Sold listing has an unusable street address; cannot safely link.',422);
   const candidates=await getRows('properties', {
     'or':`(full_address.ilike.*${m[1]}*${m[3]}*,address.ilike.*${m[1]}*${m[3]}*)`
   },100);
   const matches=candidates.filter(p=>verifiedMatch(sold,p));
   if(matches.length>1) throw err(`Ambiguous: ${matches.length} existing central property records match. Resolve duplicates first.`,409);
   return matches[0] || null;
 }
 async function getListing(mls) {
   const rows=await getRows('property_listings',{mls_number:`eq.${mls}`},3);
   if(rows.length>1) throw err('Multiple property_listings rows share the MLS number.',409);
   return rows[0]||null;
 }
 async function createProperty(sold) {
   // Explicit opt-in only. Never create a property during preview.
   const address=clean(sold.property_address);
   if(isUnit(address)) throw err('Unit/condo requires manual property resolution.',409);
   const now=new Date().toISOString();
   const payload={id:uuid(),full_address:address,street:address.split(',')[0],
     city:clean(sold.city)||null,state:clean(sold.state)||'AZ',zip:clean(sold.zip_code)||null,
     county:'Maricopa County',apn:clean(sold.parcel_number)||null,
     year_built:sold.year_built??null,living_sqft:sold.living_area_sqft??null,
     created_at:now,updated_at:now};
   const result=await rest('properties',{method:'POST',headers:{Prefer:'return=representation'},body:JSON.stringify(payload)});
   return result?.[0]||null;
 }
 async function ensureListing(sold, propertyId, existing) {
   if(existing) {
     if(clean(existing.property_id)!==clean(propertyId)) throw err('MLS number is already attached to another property.',409);
     return existing;
   }
   const now=new Date().toISOString();
   const payload={id:uuid(),property_id:propertyId,source_type:'armls',
     mls_number:clean(sold.mls_number),listing_key:clean(sold.listing_key)||null,
     listing_status:clean(sold.listing_status)||'Closed',
     modification_timestamp:null,source_payload_updated_at:null,
     created_at:now,updated_at:now};
   const result=await rest('property_listings',{method:'POST',headers:{Prefer:'return=representation'},body:JSON.stringify(payload)});
   return result?.[0]||null;
 }
 async function existingHistory(propertyId) {
   return getRows('property_history_records', {'property_id':`eq.${propertyId}`,'history_type':'eq.listing_update'},1000);
 }
 function classifyUpdates(items, old, mls) {
   return items.map(item=>{
     const exact=old.find(r=>clean(r.source_record_id)===mls && clean(r.system_type)===item.systemType && Number(r.event_year)===item.year);
     const duplicate=old.find(r=>clean(r.system_type)===item.systemType && Number(r.event_year)===item.year && clean(r.source_name).toUpperCase()==='ARMLS');
     return {...item,action:exact?'already_exists':duplicate?'already_reported_by_other_mls':'would_create',
       existingId:(exact||duplicate)?.id||null};
   });
 }
 async function saveHistory(propertyId, listingId, mls, item) {
   const now=new Date().toISOString();
   const payload={id:uuid(),property_id:propertyId,property_listing_id:listingId,
     history_type:'listing_update',system_type:item.systemType,event_year:item.year,
     update_scope:item.scope,
     statement:`${item.systemType} update reported for ${item.year}`,
     source_type:'listing_update',source_name:'ARMLS',source_record_id:mls,
     verification_status:'listing_reported',evidence_level:'source_reported',
     // Deliberately NOT a public permission grant.
     public_visible:false,agent_visible:true,homeowner_visible:false,
     created_at:now,updated_at:now};
   const rows=await rest('property_history_records',{method:'POST',headers:{Prefer:'return=representation'},body:JSON.stringify(payload)});
   return rows?.[0]||null;
 }
 export default async function handler(req,res) {
   res.setHeader('Cache-Control','private, no-store');
   res.setHeader('X-Robots-Tag','noindex, nofollow');
   if(req.method!=='POST') return res.status(405).json({success:false,error:'POST only.'});
   try {
     await administrator(req);
     const mls=clean(req.body?.mlsNumber || req.body?.mls_number);
     if(!/^\d{5,12}$/.test(mls)) throw err('Provide a valid numeric MLS number.',400);
     const commit=req.body?.commit===true;
     const allowCreateProperty=req.body?.createProperty===true;
     const soldRows=await getRows('armls_sold_properties',{mls_number:`eq.${mls}`},2);
     if(soldRows.length!==1) throw err('Sold MLS record not found or ambiguous.',404);
     const sold=soldRows[0];
     if(clean(sold.listing_status).toLowerCase()!=='closed') throw err('Record is not Closed; refusing historical sync.',409);
     if(!clean(sold.property_address)) throw err('Missing sold-property address.',422);
     const updates=updatesFromSold(sold);
     let property=await chooseProperty(sold);
     const linkedListing=await getListing(mls);
     if(linkedListing?.property_id && property && linkedListing.property_id!==property.id)
       throw err('MLS listing and address point to different property IDs.',409);
     // Existing MLS linkage may resolve a property even when its mailing address changed.
     if(!property && linkedListing?.property_id) {
       const match=await getRows('properties',{id:`eq.${linkedListing.property_id}`},1);
       if(match[0] && verifiedMatch(sold,match[0])) property=match[0];
       else throw err('Existing MLS listing has an unresolved or conflicting property identity.',409);
     }
     if(!property && (!commit || !allowCreateProperty)) {
       return res.status(200).json({success:true,mode:'preview',mlsNumber:mls,
         address:sold.property_address,propertyMatch:'not_found',
         actionRequired:'No central property record. Review the property and, only if appropriate, explicitly set createProperty:true with commit:true.',
         updates:updates.map(u=>({...u,action:'pending_property_match'})),count:updates.length,
         wrote:0});
     }
     if(!property) property=await createProperty(sold);
     if(!property?.id) throw err('Could not resolve property ID.',502);
     let old=await existingHistory(property.id);
     let planned=classifyUpdates(updates,old,mls);
     if(!commit) return res.status(200).json({success:true,mode:'preview',mlsNumber:mls,
       address:sold.property_address,propertyMatch:'existing',propertyId:property.id,
       updates:planned,count:updates.length,wrote:0});
     const listing=await ensureListing(sold,property.id,linkedListing);
     if(!listing?.id) throw err('Cannot resolve property listing ID.',502);
     const results=[];
     for(const item of planned) {
       // Re-check before every write for safer retries.
       old=await existingHistory(property.id);
       const current=classifyUpdates([item],old,mls)[0];
       if(current.action!=='would_create') { results.push(current); continue; }
       const row=await saveHistory(property.id,listing.id,mls,item);
       results.push({...item,action:'created',id:row?.id||null});
     }
     return res.status(200).json({success:true,mode:'committed',mlsNumber:mls,
       address:sold.property_address,propertyId:property.id,propertyListingId:listing.id,
       updates:results,wrote:results.filter(r=>r.action==='created').length,
       note:'Stored as non-public, unverified MLS-reported history. No rating recalculation performed.'});
   } catch(e) {
     console.error('Sold history sync failed:',e?.message);
     return res.status(e?.status||500).json({success:false,error:e?.message||'Historical sync failed.'});
   }
 }
