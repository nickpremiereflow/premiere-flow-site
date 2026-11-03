import {getPortal} from '../server/runtime.mjs';
import {safeError} from '../server/http.mjs';

export default {
  async fetch(request) {
    try {return await getPortal()(request);}
    catch(error) {return safeError(error);}
  }
};
