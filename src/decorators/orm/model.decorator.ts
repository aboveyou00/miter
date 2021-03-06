import { StaticModelT, ModelT, PkType } from '../../core/model';
import { ModelMetadata, ModelMetadataSym, ModelPropertiesSym } from '../../metadata/orm/model';
import 'reflect-metadata';
import { Pk } from './pk.decorator';

export function Model(tableName?: ModelMetadata | string) {
    let meta: ModelMetadata;
    if (typeof tableName === 'string') meta = { tableName: tableName };
    else meta = tableName || {};
    
    return function(model: StaticModelT<ModelT<PkType>>) {
        Reflect.defineMetadata(ModelMetadataSym, meta, model.prototype);
        model.db = <any>Symbol(); //Just so that future methods will be able to recognize model as a StaticModelT, even though db is undefined atm
        
        let props = Reflect.getOwnMetadata(ModelPropertiesSym, model.prototype) || [];
        if (!props.find((propName: string) => propName == 'id')) {
            Pk()(model.prototype, 'id');
            props = Reflect.getOwnMetadata(ModelPropertiesSym, model.prototype);
        }
        Reflect.defineMetadata(ModelPropertiesSym, props, model.prototype);
    }
}
