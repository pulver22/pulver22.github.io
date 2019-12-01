index=0;
for name in *.jpg
do
    cp "${name}" "${index}.jpg"
    index=$((index+1))
done
