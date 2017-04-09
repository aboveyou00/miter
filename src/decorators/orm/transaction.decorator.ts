import { Request, Response } from 'express';
import { Injector } from '../../core/injector';
import { TransactionFunctionsSym } from '../../metadata/orm/transaction';
import { TransactionService } from '../../services/transaction.service';
import { clc } from '../../util/clc';

export type TransactionFunc = ((...args: any[]) => Promise<any>);
export type TransactionFuncDescriptor = TypedPropertyDescriptor<TransactionFunc>;
export type TransactionDecoratorFunc = (target: Object, propertyKey: string, propertyDescriptor: TransactionFuncDescriptor) => void;

export function Transaction(transactionName?: string): TransactionDecoratorFunc {
    return function(prototype: any, methodName: string, routeFn: TransactionFuncDescriptor) {
        let transactionFns: string[] = Reflect.getOwnMetadata(TransactionFunctionsSym, prototype) || [];
        if (!transactionFns.find(name => name == methodName)) transactionFns.push(methodName);
        Reflect.defineMetadata(TransactionFunctionsSym, transactionFns, prototype);
        
        let originalMethod = routeFn.value!;
        routeFn.value = async function(this: any, ...args: any[]) {
            let transactionService: TransactionService | undefined = this.transactionService || this['__transaction_service'];
            if (!transactionService) {
                let protoName = (prototype && prototype.constructor && prototype.constructor.name) || prototype;
                console.error(`${clc.red('ERROR')}: Failed to wrap call to ${protoName}.${methodName} in a transaction. You need to dependency inject the TransactionService and call it 'transactionService'.`);
                return await originalMethod.call(this, ...args);
            }
            return await transactionService.run(transactionName || methodName, async () => {
                return await originalMethod.call(this, ...args);
            });
        };
        return routeFn;
    }
}