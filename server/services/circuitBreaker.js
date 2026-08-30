export class CircuitBreaker {
  constructor({failureThreshold=3,cooldownMs=30000,now=()=>Date.now()}={}){this.failureThreshold=failureThreshold;this.cooldownMs=cooldownMs;this.now=now;this.failures=0;this.openedAt=0;this.state='closed';}
  canRequest(){if(this.state!=='open')return true;if(this.now()-this.openedAt>=this.cooldownMs){this.state='half-open';return true;}return false;}
  success(){this.failures=0;this.openedAt=0;this.state='closed';}
  failure(){this.failures+=1;if(this.failures>=this.failureThreshold){this.state='open';this.openedAt=this.now();}}
  async execute(task){if(!this.canRequest())throw Object.assign(new Error('Provider temporariamente pausado pelo circuit breaker.'),{code:'CIRCUIT_OPEN'});try{const value=await task();this.success();return value;}catch(error){this.failure();throw error;}}
  status(){return{state:this.state,failures:this.failures,retryAt:this.state==='open'?new Date(this.openedAt+this.cooldownMs).toISOString():null};}
}
const breakers=new Map();
export function breakerFor(name){if(!breakers.has(name))breakers.set(name,new CircuitBreaker());return breakers.get(name);}
export function breakerStatuses(){return Object.fromEntries([...breakers].map(([name,breaker])=>[name,breaker.status()]));}
