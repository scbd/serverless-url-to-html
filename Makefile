

SAM_DIR 		:= .aws-sam/build
STACK_NAME 		:= serverless-url-to-html
PACKAGE_BUCKET	:= blaise-test

build:
	sam build --use-container

package: build #temp comment
		sam package --s3-bucket ${PACKAGE_BUCKET} --template-file ${SAM_DIR}/template.yaml --output-template-file ${SAM_DIR}/packaged.yaml
		
packageWithoutBuild:
		sam package --s3-bucket ${PACKAGE_BUCKET} --template-file ${SAM_DIR}/template.yaml --output-template-file ${SAM_DIR}/packaged.yaml

publish:package
		sam deploy --template-file ${SAM_DIR}/packaged.yaml --stack-name ${STACK_NAME} --capabilities CAPABILITY_IAM
clean:
	rm -rf ${SAM_DIR}
