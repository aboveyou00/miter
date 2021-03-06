import { CtorT } from '../../core/ctor';
import { PolicyT } from '../../core/policy';
import { PolicyMetadata, PolicyMetadataSym } from '../../metadata/policies/policy';
import { Injectable } from '../services/injectable.decorator';

export function Policy<T>(meta?: PolicyMetadata) {
    meta = meta || {};
    return function(policyFn: CtorT<PolicyT<T>>) {
        Reflect.defineMetadata(PolicyMetadataSym, meta, policyFn.prototype);
        
        Injectable()(policyFn);
    }
}
