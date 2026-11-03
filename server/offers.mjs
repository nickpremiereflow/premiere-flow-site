// Existing public offers, verified against the Premiere Flow Stripe account.
export const offers = Object.freeze({
  upgrade:{priceId:'price_1TJRzDLrMwiluTIf37Zcxhk9',amount:4900,credits:1,tier:'Upgrade',mode:'payment',linkId:'plink_1TJS4LLrMwiluTIf4ChAuKhf'},
  branding:{priceId:'price_1TJRzDLrMwiluTIf2rqETvsJ',amount:6900,credits:1,tier:'Upgrade Plus',mode:'payment',linkId:'plink_1TJSDnLrMwiluTIfCESUpfw7'},
  partner:{priceId:'price_1TJRzCLrMwiluTIfO7XfmkwK',amount:34900,credits:10,tier:'Partner Pack',mode:'payment',linkId:'plink_1TJSEqLrMwiluTIfiKp8bo3z'},
  unlimited:{priceId:'price_1TJRzCLrMwiluTIfa5GgILej',amount:99900,credits:0,tier:'Unlimited',mode:'subscription',linkId:'plink_1TJSFULrMwiluTIfw4yP7r5Q'}
});

export function offerCatalog(testPriceIds) {
  if (!testPriceIds) return offers;
  if (Object.keys(offers).some(key=>!/^price_[A-Za-z0-9]+$/.test(testPriceIds[key]||''))) throw new Error('Test offers are not configured');
  return Object.fromEntries(Object.entries(offers).map(([key,offer])=>[key,{...offer,priceId:testPriceIds[key],linkId:null}]));
}
